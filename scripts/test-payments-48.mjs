#!/usr/bin/env node
// ============================================================================
//  Payments (schema v48): PromptPay QR payloads, slip verification with a
//  MOCKED provider (a local HTTP server — the real internet is never called),
//  replay protection, manual review, Stripe webhooks, expiry, the Supporter
//  badge. Runs against SQLite and PostgreSQL (npm run test:pg).
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { io as ioClient } from 'socket.io-client';

import {
  buildPromptPayPayload, crc16, normalizePromptPayId, hasValidCrc, parseTlv, maskedMatches,
  receiverCandidates, parseSlipQr
} from '../services/payments/promptpay.js';
import { paymentsConfig, publicConfig } from '../services/payments/config.js';
import { verifySlip, checkSlipAgainstOrder } from '../services/payments/slipVerify.js';
import { verifyStripeSignature, signStripePayload, createCheckoutSession } from '../services/payments/stripe.js';

// --- mock slip provider (SlipOK shape) --------------------------------------------------
//
// The slip image carries a marker `SCENARIO:<name>:<transRef>` after the PNG
// bytes; the mock answers accordingly. It also insists on the API key header
// and the branch id in the path, so the request mapping is exercised.

const mockCalls = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    mockCalls.push({ url: req.url, auth: req.headers['x-authorization'] });
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.url !== '/api/line/apikey/BR-1' || req.headers['x-authorization'] !== 'slipok-test-key') {
      return send(401, { code: 1002, message: 'Authorization header is invalid' });
    }
    const m = /SCENARIO:([a-z_]+):([A-Za-z0-9]+)/.exec(body);
    if (!m) return send(400, { code: 1007, message: 'No QR code in image' });
    const [, scenario, ref] = m;
    const now = Date.now();
    const data = {
      success: true, message: 'ok', transRef: ref, sendingBank: '004', receivingBank: '014',
      transDate: '', transTime: '', transTimestamp: new Date(now - 30_000).toISOString(),
      amount: 100, countryCode: 'TH',
      sender: { displayName: 'นาย ผู้ส่ง', name: 'MR SENDER', proxy: { type: null, value: null }, account: { type: 'BANKAC', value: 'xxx-x-x1111-x' } },
      receiver: { displayName: 'Instance', name: 'INSTANCE', proxy: { type: 'MSISDN', value: 'xxx-xxx-5678' }, account: { type: 'BANKAC', value: 'xxx-x-x9876-x' } }
    };
    if (scenario === 'wrong_receiver') { data.receiver.proxy.value = 'xxx-xxx-9999'; data.receiver.account.value = 'xxx-x-x0000-x'; }
    if (scenario === 'underpaid') data.amount = 50;
    if (scenario === 'overpaid') data.amount = 150.5;
    if (scenario === 'old') data.transTimestamp = new Date(now - 26 * 3600_000).toISOString();
    if (scenario === 'down') return send(500, { message: 'internal' });
    if (scenario === 'fake') return send(400, { code: 1008, message: 'QR code is not a slip' });
    return send(200, { success: true, data });
  });
});

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_BASE = `http://127.0.0.1:${mock.address().port}`;

const WEBHOOK_SECRET = 'whsec_test_secret_for_payments';
Object.assign(process.env, {
  PROMPTPAY_ID: '081-234-5678',
  PROMPTPAY_NAME: 'Test Instance',
  PROMPTPAY_ACCOUNT: '1239876543',
  SLIP_VERIFY_PROVIDER: 'slipok',
  SLIPOK_API_KEY: 'slipok-test-key',
  SLIPOK_BRANCH_ID: 'BR-1',
  PAYMENTS_PROVIDER_BASE_URL: MOCK_BASE,
  STRIPE_SECRET_KEY: 'sk_test_never_used_over_the_network',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PAYMENTS_SWEEP_MS: '1000',
  PAYMENTS_SLIP_MAX_BYTES: '200000'
});

const { startServer, stopServer, BASE, PNG } = await import('./testHarness.mjs');

before(startServer);
after(async () => { await stopServer(); await new Promise((r) => mock.close(r)); });

const as = (userId) => ({ 'x-user-id': userId });

async function api(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function uploadSlip(userId, orderId, { scenario = 'ok', ref = null, bytes = null, payload = null } = {}) {
  const form = new FormData();
  const buf = bytes ?? Buffer.concat([PNG, Buffer.from(`SCENARIO:${scenario}:${ref ?? `REF${crypto.randomBytes(6).toString('hex')}`}`)]);
  if (buf.length) form.append('slip', new Blob([buf], { type: 'image/png' }), 'slip.png');
  if (payload) form.append('payload', payload);
  const res = await fetch(`${BASE}/api/payments/orders/${orderId}/slip`, { method: 'POST', headers: as(userId), body: form });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const db = () => import('../db.js');

async function makeUser(prefix, { admin = false } = {}) {
  const { runQuery } = await db();
  const id = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
  await runQuery(`INSERT INTO users (id, username, display_name, email) VALUES (?, ?, ?, ?)`, [id, id, id, `${id}@example.test`]);
  if (admin) await runQuery(`UPDATE users SET instance_admin = 1 WHERE id = ?`, [id]);
  return id;
}

async function newOrder(userId, amount = 100) {
  const res = await api('POST', '/api/payments/orders', { amount_thb: amount }, as(userId));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.order;
}

const identity = async (viewer, userId) => {
  const res = await api('GET', `/api/identities?ids=${userId}`, undefined, as(viewer));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body[userId];
};

// ---------------------------------------------------------------------------

describe('PromptPay payload (EMVCo)', () => {
  test('CRC-16/CCITT-FALSE check value', () => {
    assert.equal(crc16('123456789'), '29B1');
  });

  test('the promptpay-qr reference example: 0812345678, ฿4.22', () => {
    const payload = buildPromptPayPayload({ id: '0812345678', amountSatang: 422 });
    assert.equal(payload, '00020101021229370016A000000677010111011300668123456785802TH530376454044.2263045D49');
    assert.ok(hasValidCrc(payload));
  });

  test('static phone, national id, e-wallet', () => {
    assert.equal(buildPromptPayPayload({ id: '0812345678' }),
      '00020101021129370016A000000677010111011300668123456785802TH530376463045D82');
    assert.equal(buildPromptPayPayload({ id: '1234567890123', amountSatang: 10000 }),
      '00020101021229370016A000000677010111021312345678901235802TH53037645406100.006304BB6C');
    assert.equal(buildPromptPayPayload({ id: '123456789012345', amountSatang: 5000 }),
      '00020101021229390016A00000067701011103151234567890123455802TH5303764540550.006304B13C');
  });

  test('structure: dynamic POI, AID, currency 764, TH, amount, CRC over "6304"', () => {
    const payload = buildPromptPayPayload({ id: '+66 81 234 5678', amountSatang: 30000 });
    const top = parseTlv(payload);
    assert.equal(top.get('00'), '01');
    assert.equal(top.get('01'), '12');
    const merchant = parseTlv(top.get('29'));
    assert.equal(merchant.get('00'), 'A000000677010111');
    assert.equal(merchant.get('01'), '0066812345678');
    assert.equal(top.get('53'), '764');
    assert.equal(top.get('58'), 'TH');
    assert.equal(top.get('54'), '300.00');
    assert.equal(top.get('63'), crc16(payload.slice(0, -4)));
    assert.ok(!hasValidCrc(`${payload.slice(0, -1)}0`) || payload.endsWith('0'));
  });

  test('id normalisation and refusal', () => {
    assert.deepEqual(normalizePromptPayId('081-234-5678')?.value, '0066812345678');
    assert.equal(normalizePromptPayId('66812345678')?.type, 'phone');
    assert.equal(normalizePromptPayId('1-2345-67890-12-3')?.type, 'tax_id');
    assert.equal(normalizePromptPayId('12345')?.type, undefined);
    assert.equal(normalizePromptPayId('abc'), null);
    assert.throws(() => buildPromptPayPayload({ id: '12' }));
    assert.throws(() => buildPromptPayPayload({ id: '0812345678', amountSatang: 1.5 }));
  });

  test('masked receiver comparison', () => {
    const ours = receiverCandidates('0812345678');
    assert.ok(maskedMatches('xxx-xxx-5678', ours));
    assert.ok(maskedMatches('081-xxx-5678', ours));
    assert.ok(maskedMatches('XXX-XXX-X678', ours));
    assert.ok(maskedMatches('0066812345678', ours));
    assert.ok(!maskedMatches('xxx-xxx-5679', ours));
    assert.ok(!maskedMatches('xxx-xxx-xxxx', ours), 'fully masked never matches');
    assert.ok(!maskedMatches('091-xxx-5678', ours));
    assert.ok(maskedMatches('xxx-x-x7654-x', ['1239876543']), 'bank account 123-9-87654-3');
    assert.ok(!maskedMatches('xxx-x-x7655-x', ['1239876543']));
  });

  test('slip mini-QR: reference extracted, CRC enforced', () => {
    const inner = '0006000001' + '0103004' + '0225' + '2026092712345678901234567';
    const body = `00${String(inner.length).padStart(2, '0')}${inner}5102TH9104`;
    const payload = body + crc16(body);
    assert.deepEqual(parseSlipQr(payload), { transRef: '2026092712345678901234567', sendingBank: '004' });
    assert.equal(parseSlipQr(`${body}0000`), null);
    assert.equal(parseSlipQr('not a slip'), null);
  });
});

describe('provider mapping (fake fetch)', () => {
  const cfgFor = (env) => paymentsConfig({ PROMPTPAY_ID: '0812345678', ...env });
  const order = { amount_satang: 10000, created_at: new Date(Date.now() - 60_000).toISOString() };

  test('SlipOK: request shape and normalised slip', async () => {
    const cfg = cfgFor({ SLIP_VERIFY_PROVIDER: 'slipok', SLIPOK_API_KEY: 'k', SLIPOK_BRANCH_ID: '42' });
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ success: true, data: {
        transRef: 'ABC123', transDate: '20260927', transTime: '10:00:00', amount: 100,
        receiver: { displayName: 'x', proxy: { type: 'MSISDN', value: 'xxx-xxx-5678' }, account: { type: 'BANKAC', value: 'xxx' } }
      } }), { status: 200 });
    };
    const r = await verifySlip({ cfg, payload: 'A'.repeat(30), fetchImpl });
    assert.equal(seen.url, 'https://api.slipok.com/api/line/apikey/42');
    assert.equal(seen.init.headers['x-authorization'], 'k');
    assert.deepEqual(JSON.parse(seen.init.body), { data: 'A'.repeat(30) });
    assert.equal(r.status, 'verified');
    assert.equal(r.slip.amountSatang, 10000);
    assert.equal(r.slip.transAt, '2026-09-27T03:00:00.000Z', 'Bangkok wall clock → UTC');
  });

  test('EasySlip: request shape, normalised slip, invalid vs unavailable', async () => {
    const cfg = cfgFor({ SLIP_VERIFY_PROVIDER: 'easyslip', EASYSLIP_API_KEY: 'e' });
    let seen;
    const ok = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ status: 200, data: {
        transRef: 'E1', date: new Date().toISOString(), amount: { amount: 120 },
        receiver: { account: { name: { th: 'นาย' }, bank: { type: 'BANKAC', account: 'xxx' }, proxy: { type: 'MSISDN', account: '081-xxx-5678' } } }
      } }), { status: 200 });
    };
    const r = await verifySlip({ cfg, image: { buffer: PNG, mime: 'image/png' }, fetchImpl: ok });
    assert.equal(seen.url, 'https://developer.easyslip.com/api/v1/verify');
    assert.equal(seen.init.headers.Authorization, 'Bearer e');
    assert.ok(seen.init.body instanceof FormData && seen.init.body.get('file'));
    assert.equal(r.status, 'verified');
    assert.equal(checkSlipAgainstOrder(r.slip, order, cfg), null);

    const notFound = async () => new Response(JSON.stringify({ status: 404, message: 'slip_not_found' }), { status: 404 });
    assert.equal((await verifySlip({ cfg, payload: 'B'.repeat(30), fetchImpl: notFound })).status, 'invalid');
    const quota = async () => new Response(JSON.stringify({ status: 403, message: 'quota_exceeded' }), { status: 403 });
    assert.equal((await verifySlip({ cfg, payload: 'B'.repeat(30), fetchImpl: quota })).status, 'unavailable');
    const boom = async () => { throw new TypeError('fetch failed'); };
    assert.equal((await verifySlip({ cfg, payload: 'B'.repeat(30), fetchImpl: boom })).status, 'unavailable');
  });

  test('order checks: receiver, amount, too early, too old', () => {
    const cfg = cfgFor({});
    const good = { transRef: 'x', amountSatang: 10000, transAt: new Date().toISOString(), receiver: { proxy: 'xxx-xxx-5678' } };
    assert.equal(checkSlipAgainstOrder(good, order, cfg), null);
    assert.equal(checkSlipAgainstOrder({ ...good, receiver: { proxy: 'xxx-xxx-1111' } }, order, cfg), 'SLIP_WRONG_RECEIVER');
    assert.equal(checkSlipAgainstOrder({ ...good, amountSatang: 9999 }, order, cfg), 'SLIP_UNDERPAID');
    assert.equal(checkSlipAgainstOrder({ ...good, transAt: new Date(Date.now() - 3600_000).toISOString() }, order, cfg), 'SLIP_TOO_EARLY');
    const oldOrder = { ...order, created_at: new Date(Date.now() - 30 * 3600_000).toISOString() };
    assert.equal(checkSlipAgainstOrder({ ...good, transAt: new Date(Date.now() - 25 * 3600_000).toISOString() }, oldOrder, cfg), 'SLIP_TOO_OLD');
  });

  test('disabled unless configured; a provider without keys falls back to manual', () => {
    assert.deepEqual(publicConfig(paymentsConfig({})), { enabled: false });
    assert.equal(paymentsConfig({ PROMPTPAY_ID: 'nonsense' }).enabled, false);
    assert.equal(paymentsConfig({ STRIPE_SECRET_KEY: 'sk' }).enabled, false, 'both Stripe keys are required');
    assert.equal(paymentsConfig({ STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh' }).enabled, true);
    assert.equal(paymentsConfig({ PROMPTPAY_ID: '0812345678', SLIP_VERIFY_PROVIDER: 'slipok' }).provider, 'manual');
    assert.equal(paymentsConfig({ PROMPTPAY_ID: '0812345678', PAYMENTS_PROVIDER_BASE_URL: 'http://x', NODE_ENV: 'production' }).providerBaseOverride, null);
  });

  test('Stripe signature: good, tampered, stale, rotated secret', () => {
    const rawBody = Buffer.from('{"id":"evt_1"}');
    const header = signStripePayload({ rawBody, secret: 'whsec_a' });
    assert.ok(verifyStripeSignature({ rawBody, header, secret: 'whsec_a' }));
    assert.ok(!verifyStripeSignature({ rawBody: Buffer.from('{"id":"evt_2"}'), header, secret: 'whsec_a' }));
    assert.ok(!verifyStripeSignature({ rawBody, header, secret: 'whsec_b' }));
    const stale = signStripePayload({ rawBody, secret: 'whsec_a', timestamp: Math.floor(Date.now() / 1000) - 400 });
    assert.ok(!verifyStripeSignature({ rawBody, header: stale, secret: 'whsec_a' }));
    const two = `${header},v1=${'0'.repeat(64)}`;
    assert.ok(verifyStripeSignature({ rawBody, header: two, secret: 'whsec_a' }));
    assert.ok(!verifyStripeSignature({ rawBody, header: 't=abc,v1=zz', secret: 'whsec_a' }));
  });

  test('Stripe Checkout: fixed host, thb, card + promptpay, idempotency key', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', expires_at: 1 }), { status: 200 });
    };
    const orderRow = { id: '123', user_id: 'u1', amount_satang: 30000, expires_at: new Date(Date.now() + 3600_000).toISOString() };
    const s = await createCheckoutSession({ secretKey: 'sk_test', order: orderRow, publicUrl: 'https://chat.example', fetchImpl });
    assert.equal(s.id, 'cs_test_1');
    assert.equal(seen.url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(seen.init.headers.Authorization, 'Bearer sk_test');
    assert.equal(seen.init.headers['Idempotency-Key'], 'order-123');
    const form = new URLSearchParams(seen.init.body);
    assert.equal(form.get('line_items[0][price_data][currency]'), 'thb');
    assert.equal(form.get('line_items[0][price_data][unit_amount]'), '30000');
    assert.equal(form.get('payment_method_types[0]'), 'card');
    assert.equal(form.get('payment_method_types[1]'), 'promptpay');
    assert.equal(form.get('client_reference_id'), '123');
    const bad = async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 400 });
    await assert.rejects(createCheckoutSession({ secretKey: 'sk', order: orderRow, publicUrl: 'x', fetchImpl: bad }));
  });
});

describe('orders over HTTP', () => {
  test('config is public-safe', async () => {
    const res = await api('GET', '/api/payments/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.deepEqual(res.body.methods, { promptpay: true, stripe: true });
    assert.deepEqual(res.body.presets, [50, 100, 300, 500]);
    assert.equal(res.body.min_thb, 20);
    assert.equal(res.body.max_thb, 50000);
    assert.equal(res.body.receiver_name, 'Test Instance');
    assert.equal(res.body.receiver_hint, '••••••5678');
    assert.equal(res.body.verification, 'automatic');
    const text = JSON.stringify(res.body);
    for (const secret of ['slipok-test-key', 'sk_test', WEBHOOK_SECRET, '0812345678', MOCK_BASE]) assert.ok(!text.includes(secret), secret);
  });

  test('order validation', async () => {
    const me = await makeUser('val');
    assert.equal((await api('POST', '/api/payments/orders', { amount_thb: 100 })).status, 401);
    for (const [amount, code] of [[19, 'AMOUNT_OUT_OF_RANGE'], [50001, 'AMOUNT_OUT_OF_RANGE'], [100.5, 'INVALID_AMOUNT'],
      ['abc', 'INVALID_AMOUNT'], [null, 'INVALID_AMOUNT'], [-5, 'AMOUNT_OUT_OF_RANGE']]) {
      const res = await api('POST', '/api/payments/orders', { amount_thb: amount }, as(me));
      assert.equal(res.status, 400, `${amount}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, code);
    }
    const bad = await api('POST', '/api/payments/orders', { amount_thb: 100, method: 'bitcoin' }, as(me));
    assert.equal(bad.body.code, 'INVALID_METHOD');

    const order = await newOrder(me, 20);
    assert.equal(order.status, 'pending');
    assert.equal(order.amount_satang, 2000);
    assert.ok(hasValidCrc(order.qr_payload));
    assert.ok(order.qr_payload.includes('540520.00'));
    assert.ok(order.qr_payload.includes('0066812345678'));
    const ttl = Date.parse(order.expires_at) - Date.parse(order.created_at);
    assert.ok(Math.abs(ttl - 30 * 60_000) < 5000, `30 minutes, got ${ttl}`);
    await newOrder(me, 50000);
    await newOrder(me, '300');
    const fourth = await api('POST', '/api/payments/orders', { amount_thb: 100 }, as(me));
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.code, 'TOO_MANY_OPEN_ORDERS');
    const history = await api('GET', '/api/payments/orders', undefined, as(me));
    assert.equal(history.body.orders.length, 3);
  });

  test('non-owner cannot read an order; the owner and an admin can', async () => {
    const owner = await makeUser('own');
    const other = await makeUser('oth');
    const admin = await makeUser('adm', { admin: true });
    const order = await newOrder(owner);
    assert.equal((await api('GET', `/api/payments/orders/${order.id}`, undefined, as(owner))).status, 200);
    const denied = await api('GET', `/api/payments/orders/${order.id}`, undefined, as(other));
    assert.equal(denied.status, 404);
    assert.equal((await api('GET', `/api/payments/orders/${order.id}`)).status, 401);
    const up = await uploadSlip(other, order.id);
    assert.equal(up.status, 404, 'nor send a slip for it');
    const viaAdmin = await api('GET', `/api/payments/orders/${order.id}`, undefined, as(admin));
    assert.equal(viaAdmin.status, 200);
    assert.equal(viaAdmin.body.order.user_id, owner);
  });

  test('slip happy path → paid, socket event, Supporter badge in identity', async () => {
    const me = await makeUser('happy');
    const viewer = await makeUser('view');
    assert.ok(!(await identity(viewer, me)).badges.some((b) => b.slug === 'supporter'));
    const order = await newOrder(me, 100);

    const socket = ioClient(BASE, { transports: ['websocket'], forceNew: true });
    await new Promise((resolve, reject) => {
      const fail = setTimeout(() => reject(new Error('socket did not identify')), 5000);
      socket.on('connect', () => socket.emit('identify', { userId: me }));
      socket.on('identified', () => { clearTimeout(fail); resolve(); });
    });
    const event = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 4000);
      socket.on('payment_updated', (p) => { clearTimeout(t); resolve(p); });
    });

    const res = await uploadSlip(me, order.id, { scenario: 'ok' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.result, 'paid');
    assert.equal(res.body.order.status, 'paid');
    assert.ok(res.body.order.paid_at);
    const payload = await event;
    socket.close();
    assert.equal(payload?.order?.id, order.id);
    assert.equal(payload?.paid, true);

    const badges = (await identity(viewer, me)).badges;
    const supporter = badges.find((b) => b.slug === 'supporter');
    assert.ok(supporter, JSON.stringify(badges));
    assert.equal(supporter.kind, 'system');

    // The supporter can hide it.
    assert.equal((await api('PUT', '/api/payments/supporter', { badge_hidden: true }, as(me))).status, 200);
    assert.ok(!(await identity(viewer, me)).badges.some((b) => b.slug === 'supporter'));
    await api('PUT', '/api/payments/supporter', { badge_hidden: false }, as(me));

    // A paid order takes no more slips.
    const again = await uploadSlip(me, order.id);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ALREADY_PAID');
    assert.ok(mockCalls.every((c) => c.auth === 'slipok-test-key'));

    const { getQuery } = await db();
    const auditRow = await getQuery(`SELECT * FROM instance_audit_log WHERE action = 'payment_paid' AND target_id = ?`, [order.id]);
    assert.ok(auditRow, 'written to the admin audit log');
  });

  test('overpaying is fine; wrong receiver, underpaid, old and fake slips are not', async () => {
    const me = await makeUser('checks');
    const order = await newOrder(me, 100);
    for (const [scenario, code] of [['wrong_receiver', 'SLIP_WRONG_RECEIVER'], ['underpaid', 'SLIP_UNDERPAID'],
      ['old', 'SLIP_TOO_EARLY'], ['fake', 'SLIP_NOT_VERIFIED']]) {
      const res = await uploadSlip(me, order.id, { scenario });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.result, 'failed', scenario);
      assert.equal(res.body.check_code, code, scenario);
      assert.equal(res.body.order.status, 'pending');
      assert.equal(res.body.order.display_status, 'verifying');
    }
    const ok = await uploadSlip(me, order.id, { scenario: 'overpaid' });
    assert.equal(ok.body.result, 'paid', JSON.stringify(ok.body));
    const { getQuery } = await db();
    const row = await getQuery(`SELECT paid_amount_satang FROM payment_orders WHERE id = ?`, [order.id]);
    assert.equal(Number(row.paid_amount_satang), 15050);
  });

  test('five failed slips reject the order', async () => {
    const me = await makeUser('five');
    const order = await newOrder(me, 100);
    let last;
    for (let i = 0; i < 5; i += 1) last = await uploadSlip(me, order.id, { scenario: 'underpaid' });
    assert.equal(last.body.order.status, 'rejected');
    const sixth = await uploadSlip(me, order.id);
    assert.equal(sixth.status, 409);
  });

  test('slip files: images only, size-capped, magic bytes decide', async () => {
    const me = await makeUser('files');
    const order = await newOrder(me, 100);
    let res = await uploadSlip(me, order.id, { bytes: Buffer.from('#!/bin/sh\necho SCENARIO:ok:X1\n'.repeat(3)) });
    assert.equal(res.status, 415);
    res = await uploadSlip(me, order.id, { bytes: Buffer.concat([PNG, Buffer.alloc(250_000)]) });
    assert.equal(res.status, 413);
    res = await uploadSlip(me, order.id, { bytes: Buffer.alloc(0) });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'SLIP_MISSING');
    res = await uploadSlip(me, order.id, { bytes: Buffer.alloc(0), payload: 'short' });
    assert.equal(res.body.code, 'INVALID_SLIP_PAYLOAD');
  });

  test('replay: the same transaction reference pays once — across users, and concurrently', async () => {
    const a = await makeUser('ra');
    const b = await makeUser('rb');
    const ref = `REPLAY${crypto.randomBytes(5).toString('hex')}`;
    const oa = await newOrder(a, 100);
    const first = await uploadSlip(a, oa.id, { ref });
    assert.equal(first.body.result, 'paid');
    const ob = await newOrder(b, 100);
    const second = await uploadSlip(b, ob.id, { ref });
    assert.equal(second.body.result, 'failed');
    assert.equal(second.body.check_code, 'SLIP_DUPLICATE');
    assert.equal(second.body.order.status, 'pending');

    // The very same image bytes are refused before any provider is asked.
    const oc = await newOrder(a, 100);
    const sameImage = Buffer.concat([PNG, Buffer.from(`SCENARIO:ok:${ref}`)]);
    const third = await uploadSlip(a, oc.id, { bytes: sameImage });
    assert.equal(third.body.check_code, 'SLIP_DUPLICATE');
    assert.equal(third.body.order.display_status, 'verifying', 'kept for an admin to see');
    {
      const { getQuery } = await db();
      const kept = await getQuery(`SELECT slip_file_id FROM payment_orders WHERE id = ?`, [oc.id]);
      assert.ok(kept.slip_file_id, 'the duplicate slip is stored as evidence');
    }

    // Concurrent: five users, five orders, one reference, at once.
    const ref2 = `RACE${crypto.randomBytes(5).toString('hex')}`;
    const users = await Promise.all([1, 2, 3, 4, 5].map((i) => makeUser(`race${i}`)));
    const racers = await Promise.all(users.map((u) => newOrder(u, 100)));
    const results = await Promise.all(racers.map((o, i) => uploadSlip(users[i], o.id, {
      bytes: Buffer.concat([PNG, Buffer.from(`SCENARIO:ok:${ref2} #${i}`)])
    })));
    const paid = results.filter((r) => r.body.result === 'paid');
    const dup = results.filter((r) => r.body.check_code === 'SLIP_DUPLICATE');
    assert.equal(paid.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal(dup.length, 4);
    const { getQuery } = await db();
    const n = await getQuery(`SELECT count(*) AS n FROM payment_orders WHERE trans_ref = ?`, [ref2]);
    assert.equal(Number(n.n), 1);
  });

  test('provider unavailable → manual review; approve needs an instance admin', async () => {
    const me = await makeUser('manual');
    const plain = await makeUser('plain');
    const admin = await makeUser('boss', { admin: true });
    const order = await newOrder(me, 300);
    const res = await uploadSlip(me, order.id, { scenario: 'down' });
    assert.equal(res.body.result, 'review');
    assert.equal(res.body.order.display_status, 'verifying');
    assert.equal(res.body.check_code, 'SLIP_REVIEW');

    const list = await api('GET', '/api/admin/payments?status=verifying', undefined, as(admin));
    assert.equal(list.status, 200);
    const mine = list.body.orders.find((o) => o.id === order.id);
    assert.ok(mine, 'listed for review');
    assert.ok(mine.slip_url?.startsWith(`/api/files/`), 'signed slip preview');
    const preview = await fetch(`${BASE}${mine.slip_url}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${BASE}${mine.slip_url.split('?')[0]}`, { headers: as(plain) })).status, 403, 'private file');
    assert.ok(list.body.totals.awaiting_review >= 1);

    assert.equal((await api('GET', '/api/admin/payments', undefined, as(plain))).status, 403);
    const denied = await api('POST', `/api/admin/payments/${order.id}/approve`, {}, as(plain));
    assert.equal(denied.status, 403);
    assert.equal((await api('POST', `/api/admin/payments/${order.id}/approve`, {}, as(me))).status, 403, 'not even the payer');

    const ok = await api('POST', `/api/admin/payments/${order.id}/approve`, { reason: 'checked the bank app' }, as(admin));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.order.status, 'paid');
    assert.equal((await api('POST', `/api/admin/payments/${order.id}/approve`, {}, as(admin))).status, 409);
    const viewer = await makeUser('v2');
    assert.ok((await identity(viewer, me)).badges.some((b) => b.slug === 'supporter'));

    const { getQuery } = await db();
    const auditRow = await getQuery(`SELECT * FROM instance_audit_log WHERE action = 'payment_approve' AND target_id = ?`, [order.id]);
    assert.equal(auditRow?.actor_id, admin);
  });

  test('reject needs a reason, and the payer sees it', async () => {
    const me = await makeUser('rej');
    const admin = await makeUser('boss2', { admin: true });
    const order = await newOrder(me, 100);
    await uploadSlip(me, order.id, { scenario: 'down' });
    const noReason = await api('POST', `/api/admin/payments/${order.id}/reject`, {}, as(admin));
    assert.equal(noReason.body.code, 'REASON_REQUIRED');
    const ok = await api('POST', `/api/admin/payments/${order.id}/reject`, { reason: 'Slip is for another shop' }, as(admin));
    assert.equal(ok.body.order.status, 'rejected');
    const mine = await api('GET', `/api/payments/orders/${order.id}`, undefined, as(me));
    assert.equal(mine.body.order.reason, 'Slip is for another shop');
    const { getQuery } = await db();
    assert.ok(await getQuery(`SELECT 1 FROM instance_audit_log WHERE action = 'payment_reject' AND target_id = ?`, [order.id]));
  });

  test('expiry sweeper: unpaid orders expire, orders with a slip wait for review', async () => {
    const me = await makeUser('exp');
    const a = await newOrder(me, 100);
    const b = await newOrder(me, 100);
    await uploadSlip(me, b.id, { scenario: 'down' });
    const { runQuery } = await db();
    await runQuery(`UPDATE payment_orders SET expires_at = ? WHERE id IN (?, ?)`, [new Date(Date.now() - 1000).toISOString(), a.id, b.id]);
    let status = null;
    for (let i = 0; i < 40 && status !== 'expired'; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      status = (await api('GET', `/api/payments/orders/${a.id}`, undefined, as(me))).body.order.status;
    }
    assert.equal(status, 'expired');
    assert.equal((await api('GET', `/api/payments/orders/${b.id}`, undefined, as(me))).body.order.status, 'pending');
    // A slip for an expired order is still accepted (paid at minute 29).
    const late = await uploadSlip(me, a.id, { scenario: 'ok' });
    assert.equal(late.body.result, 'paid', JSON.stringify(late.body));
  });
});

describe('Stripe webhook', () => {
  async function stripeOrder(userId, amount = 300) {
    const { runQuery } = await db();
    const id = String(BigInt(Date.now()) * 1000n + BigInt(crypto.randomInt(1000)));
    await runQuery(
      `INSERT INTO payment_orders (id, user_id, amount_satang, method, status, provider, provider_ref, expires_at)
       VALUES (?, ?, ?, 'stripe', 'pending', 'stripe', ?, ?)`,
      [id, userId, amount * 100, `cs_test_${id}`, new Date(Date.now() + 3600_000).toISOString()]
    );
    return id;
  }
  const deliver = (event, { secret = WEBHOOK_SECRET, header = null } = {}) => {
    const raw = Buffer.from(JSON.stringify(event));
    return fetch(`${BASE}/api/payments/stripe/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header ?? signStripePayload({ rawBody: raw, secret }) },
      body: raw
    });
  };
  const completed = (orderId, { eventId = `evt_${crypto.randomBytes(8).toString('hex')}`, amount = 30000, status = 'paid' } = {}) => ({
    id: eventId, type: 'checkout.session.completed',
    data: { object: { id: `cs_test_${orderId}`, client_reference_id: orderId, payment_status: status,
      amount_total: amount, currency: 'thb', payment_intent: `pi_${orderId}`, metadata: { order_id: orderId } } }
  });

  test('bad signature → 400, nothing changes', async () => {
    const me = await makeUser('sbad');
    const orderId = await stripeOrder(me);
    let res = await deliver(completed(orderId), { secret: 'whsec_wrong' });
    assert.equal(res.status, 400);
    res = await deliver(completed(orderId), { header: 'garbage' });
    assert.equal(res.status, 400);
    const stale = signStripePayload({ rawBody: Buffer.from('{}'), secret: WEBHOOK_SECRET, timestamp: 1 });
    res = await deliver(completed(orderId), { header: stale });
    assert.equal(res.status, 400);
    const { getQuery } = await db();
    assert.equal((await getQuery(`SELECT status FROM payment_orders WHERE id = ?`, [orderId])).status, 'pending');
  });

  test('good signature → paid exactly once, even when delivered twice', async () => {
    const me = await makeUser('sgood');
    const viewer = await makeUser('sview');
    const orderId = await stripeOrder(me);
    const event = completed(orderId);
    const [r1, r2] = await Promise.all([deliver(event), deliver(event)]);
    assert.deepEqual([r1.status, r2.status], [200, 200]);
    const bodies = [await r1.json(), await r2.json()];
    assert.equal(bodies.filter((b) => b.duplicate).length, 1, JSON.stringify(bodies));
    const r3 = await deliver(event);
    assert.equal((await r3.json()).duplicate, true);
    // A second, different event for the same session changes nothing.
    await deliver({ ...completed(orderId), type: 'checkout.session.async_payment_succeeded' });

    const { getQuery } = await db();
    const row = await getQuery(`SELECT status, trans_ref FROM payment_orders WHERE id = ?`, [orderId]);
    assert.equal(row.status, 'paid');
    assert.equal(row.trans_ref, `pi_${orderId}`);
    const audits = await getQuery(`SELECT count(*) AS n FROM instance_audit_log WHERE action = 'payment_paid' AND target_id = ?`, [orderId]);
    assert.equal(Number(audits.n), 1);
    assert.ok((await identity(viewer, me)).badges.some((b) => b.slug === 'supporter'));

    // Refund: the order is refunded and, with no other paid order, the badge goes.
    const refund = { id: `evt_${crypto.randomBytes(8).toString('hex')}`, type: 'charge.refunded',
      data: { object: { id: 'ch_1', refunded: true, payment_intent: `pi_${orderId}` } } };
    assert.equal((await deliver(refund)).status, 200);
    assert.equal((await getQuery(`SELECT status FROM payment_orders WHERE id = ?`, [orderId])).status, 'refunded');
    assert.ok(!(await identity(viewer, me)).badges.some((b) => b.slug === 'supporter'));
  });

  test('async PromptPay: unpaid completion waits, success pays, short amount is ignored', async () => {
    const me = await makeUser('sasync');
    const orderId = await stripeOrder(me);
    await deliver(completed(orderId, { status: 'unpaid' }));
    const { getQuery } = await db();
    assert.equal((await getQuery(`SELECT status FROM payment_orders WHERE id = ?`, [orderId])).status, 'pending');
    await deliver({ ...completed(orderId, { amount: 100 }), type: 'checkout.session.async_payment_succeeded' });
    assert.equal((await getQuery(`SELECT status FROM payment_orders WHERE id = ?`, [orderId])).status, 'pending');
    await deliver({ ...completed(orderId), type: 'checkout.session.async_payment_succeeded' });
    assert.equal((await getQuery(`SELECT status FROM payment_orders WHERE id = ?`, [orderId])).status, 'paid');
  });
});
