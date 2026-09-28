// ============================================================================
//  Donation orders: create, show, verify a slip, approve / reject, expire,
//  Stripe webhook events. Amounts are integer satang throughout.
//
//  Lifecycle
//    pending ──slip ok──────────▶ paid        (automatic verification)
//    pending ──admin approve────▶ paid        (manual, or when the provider
//                                              could not decide)
//    pending ──admin reject─────▶ rejected    (reason shown to the payer)
//    pending ──30 min, no slip──▶ expired     (sweeper)
//    paid    ──Stripe refund────▶ refunded
//  A slip may still be sent for an expired order (the payer may have paid at
//  minute 29); the slip's own time is what is checked.
//
//  "verifying" is not stored: it is a pending order that has a slip waiting.
// ============================================================================

import crypto from 'node:crypto';

import { runQuery, getQuery, allQuery, transaction, sql } from '../../db.js';
import { isUniqueViolation } from '../../db/dialect.js';
import { generateId } from '../../lib/snowflake.js';
import { ApiError } from '../../lib/httpUtils.js';
import { sniffMime } from '../../lib/mediaProbe.js';
import { storeFile, addReference, releaseReference, signFileUrl } from '../../storageService.js';
import { audit, isInstanceAdmin } from '../instanceAdmin.js';
import { buildPromptPayPayload, parseSlipQr } from './promptpay.js';
import { verifySlip, checkSlipAgainstOrder } from './slipVerify.js';
import { createCheckoutSession } from './stripe.js';

export const SLIP_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const OPEN = `('pending')`;

const nowIso = () => new Date().toISOString();

export function disabledError() {
  return new ApiError('Payments are not enabled on this instance', { status: 404, code: 'PAYMENTS_DISABLED' });
}

function displayStatus(row) {
  if (row.status === 'pending' && row.slip_submitted_at) return 'verifying';
  return row.status;
}

/** What the payer (and an admin) sees. */
export function shapeOrder(row, cfg, { admin = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    amount_satang: Number(row.amount_satang),
    amount_thb: Number(row.amount_satang) / 100,
    currency: row.currency,
    method: row.method,
    status: row.status,
    display_status: displayStatus(row),
    check_code: row.check_code ?? null,
    reason: row.status === 'rejected' || row.status === 'refunded' ? (row.note ?? null) : null,
    has_slip: Boolean(row.slip_file_id || row.slip_payload),
    slip_attempts: Number(row.slip_attempts ?? 0),
    created_at: row.created_at,
    expires_at: row.expires_at,
    paid_at: row.paid_at ?? null
  };
  if (row.method === 'promptpay' && (row.status === 'pending' || row.status === 'expired') && cfg?.promptPayId) {
    out.qr_payload = buildPromptPayPayload({ id: cfg.promptPayId, amountSatang: Number(row.amount_satang) });
    out.receiver_name = cfg.promptPayName;
    out.receiver_hint = cfg.promptPayHint;
  }
  if (admin) {
    Object.assign(out, {
      user_id: row.user_id,
      username: row.username ?? null,
      display_name: row.display_name ?? null,
      provider: row.provider ?? null,
      provider_ref: row.provider_ref ?? null,
      trans_ref: row.trans_ref ?? null,
      paid_amount_satang: row.paid_amount_satang == null ? null : Number(row.paid_amount_satang),
      note: row.note ?? null,
      slip_payload: row.slip_payload ?? null,
      slip_submitted_at: row.slip_submitted_at ?? null,
      reviewed_by: row.reviewed_by ?? null,
      // Short-lived signed URL: the slip is a private file.
      slip_url: row.slip_file_id ? signFileUrl(row.slip_file_id, { ttlSeconds: 900 }) : null,
      duplicate_of: row.duplicate_of ?? null
    });
  }
  return out;
}

const ORDER_SELECT = `SELECT o.*, u.username, u.display_name FROM payment_orders o LEFT JOIN users u ON u.id = o.user_id`;

export const getOrderRow = (id) => getQuery(`${ORDER_SELECT} WHERE o.id = ?`, [String(id ?? '')]);

/** Owner or instance admin; anyone else gets the same 404 as a missing order. */
export async function getOrderFor({ orderId, viewerId }) {
  const row = await getOrderRow(orderId);
  if (!row) throw ApiError.notFound('Order');
  const admin = row.user_id !== viewerId && await isInstanceAdmin(viewerId);
  if (row.user_id !== viewerId && !admin) throw ApiError.notFound('Order');
  return { row, admin };
}

export function parseAmountThb(raw, cfg) {
  const n = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new ApiError('Enter a whole number of baht', { code: 'INVALID_AMOUNT', details: { min: cfg.minThb, max: cfg.maxThb } });
  }
  if (n < cfg.minThb || n > cfg.maxThb) {
    throw new ApiError(`Choose an amount from ฿${cfg.minThb} to ฿${cfg.maxThb}`, {
      code: 'AMOUNT_OUT_OF_RANGE', details: { min: cfg.minThb, max: cfg.maxThb }
    });
  }
  return n;
}

export async function createOrder({ userId, amountThb, method = 'promptpay', cfg, publicUrl, fetchImpl }) {
  if (!cfg.enabled) throw disabledError();
  if (method !== 'promptpay' && method !== 'stripe') throw new ApiError('Unknown payment method', { code: 'INVALID_METHOD' });
  if (method === 'promptpay' && !cfg.promptPayId) throw new ApiError('PromptPay is not set up here', { code: 'METHOD_UNAVAILABLE' });
  if (method === 'stripe' && !cfg.stripe) throw new ApiError('Card payments are not set up here', { code: 'METHOD_UNAVAILABLE' });
  const baht = parseAmountThb(amountThb, cfg);

  const open = await getQuery(
    `SELECT count(*) AS n FROM payment_orders WHERE user_id = ? AND status IN ${OPEN} AND slip_submitted_at IS NULL
        AND expires_at > ${sql.now}`, [userId]
  );
  if (Number(open?.n ?? 0) >= cfg.maxOpenOrders) {
    throw new ApiError('Finish or wait out your open payments first', { status: 429, code: 'TOO_MANY_OPEN_ORDERS' });
  }

  const id = generateId();
  const ttl = method === 'stripe' ? cfg.stripeTtlMs : cfg.orderTtlMs;
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  const createdAt = nowIso();
  await runQuery(
    `INSERT INTO payment_orders (id, user_id, amount_satang, currency, method, status, provider, created_at, expires_at, updated_at)
     VALUES (?, ?, ?, 'THB', ?, 'pending', ?, ?, ?, ?)`,
    [id, userId, baht * 100, method, method === 'stripe' ? 'stripe' : cfg.provider, createdAt, expiresAt, createdAt]
  );
  let row = await getOrderRow(id);
  let checkoutUrl = null;
  if (method === 'stripe') {
    try {
      const session = await createCheckoutSession({
        secretKey: cfg.stripeKeys.secret, order: row, publicUrl, fetchImpl
      });
      await runQuery(`UPDATE payment_orders SET provider_ref = ?, updated_at = ${sql.now} WHERE id = ?`, [session.id, id]);
      checkoutUrl = session.url;
      row = await getOrderRow(id);
    } catch (err) {
      await runQuery(`UPDATE payment_orders SET status = 'rejected', note = ?, updated_at = ${sql.now} WHERE id = ?`,
        ['Stripe checkout could not be started', id]);
      throw new ApiError('Card payments are unavailable right now — try PromptPay or again later',
        { status: 502, code: 'STRIPE_UNAVAILABLE' });
    }
  }
  return { order: shapeOrder(row, cfg), checkout_url: checkoutUrl };
}

export async function listOrdersForUser(userId, cfg, { limit = 20 } = {}) {
  const rows = await allQuery(
    `${ORDER_SELECT} WHERE o.user_id = ? ORDER BY o.created_at DESC, o.id DESC LIMIT ${Math.min(50, Math.max(1, limit))}`,
    [userId]
  );
  return rows.map((r) => shapeOrder(r, cfg));
}

// --- paying ---------------------------------------------------------------------------

/**
 * Mark an order paid. Idempotent and race-safe: only a row still in one of
 * `from` changes, and trans_ref is UNIQUE — a slip that already paid another
 * order throws { code: 'SLIP_DUPLICATE' }. Returns the new row, or null when
 * the order was no longer payable (someone else got there first).
 */
export async function markPaid({ orderId, transRef = null, paidAmountSatang = null, actorId = null,
  from = ['pending', 'expired'], via, note = null }) {
  let changed = false;
  try {
    await transaction(async () => {
      const marks = from.map(() => '?').join(',');
      const res = await runQuery(
        `UPDATE payment_orders
            SET status = 'paid', trans_ref = COALESCE(?, trans_ref), paid_amount_satang = COALESCE(?, amount_satang),
                paid_at = ${sql.now}, updated_at = ${sql.now}, check_code = NULL,
                reviewed_by = ?, note = COALESCE(?, note)
          WHERE id = ? AND status IN (${marks})`,
        [transRef, paidAmountSatang, actorId, note, orderId, ...from]
      );
      if (!res.changes) return;
      changed = true;
      const row = await getQuery(`SELECT user_id, amount_satang FROM payment_orders WHERE id = ?`, [orderId]);
      if (row?.user_id) {
        await runQuery(`UPDATE users SET supporter_since = COALESCE(supporter_since, ${sql.now}) WHERE id = ?`, [row.user_id]);
      }
      await audit({
        actorId, action: actorId ? 'payment_approve' : 'payment_paid', targetType: 'payment', targetId: orderId,
        details: { via, amount_satang: Number(row?.amount_satang ?? 0), trans_ref: transRef ?? undefined, user_id: row?.user_id }
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError('This slip has already been used', { status: 409, code: 'SLIP_DUPLICATE' });
    throw err;
  }
  return changed ? getOrderRow(orderId) : null;
}

async function recordCheck(orderId, code, cfg) {
  const row = await getOrderRow(orderId);
  const exhausted = Number(row.slip_attempts) >= cfg.maxSlipAttempts && code !== 'SLIP_REVIEW';
  await runQuery(
    `UPDATE payment_orders SET check_code = ?, updated_at = ${sql.now}
       ${exhausted ? `, status = 'rejected', note = ?` : ''}
     WHERE id = ? AND status IN ('pending','expired')`,
    exhausted ? [code, 'Too many slips could not be verified', orderId] : [code, orderId]
  );
  if (exhausted) {
    await audit({ actorId: null, action: 'payment_reject', targetType: 'payment', targetId: orderId,
      details: { via: 'automatic', code, user_id: row.user_id } });
  }
  return getOrderRow(orderId);
}

const SLIP_PAYLOAD_RE = /^[0-9A-Za-z]{20,512}$/;

/**
 * A slip for a PromptPay order: an image (jpeg/png/webp, size-capped,
 * magic-byte checked) and/or the slip's QR payload string.
 * Returns { order, result: 'paid' | 'review' | 'failed', check_code }.
 */
export async function submitSlip({ orderId, userId, image = null, payload = null, cfg, fetchImpl }) {
  if (!cfg.enabled) throw disabledError();
  const row = await getOrderRow(orderId);
  if (!row || row.user_id !== userId) throw ApiError.notFound('Order');
  if (row.method !== 'promptpay') throw new ApiError('This order is not paid by slip', { code: 'WRONG_METHOD' });
  if (row.status === 'paid') throw new ApiError('This order is already paid', { status: 409, code: 'ALREADY_PAID' });
  if (row.status === 'rejected' || row.status === 'refunded') {
    throw new ApiError('This order is closed — start a new one', { status: 409, code: 'ORDER_CLOSED' });
  }
  if (Date.now() - Date.parse(row.created_at) > cfg.slipWindowMs) {
    throw new ApiError('This order is too old for a slip — start a new one', { status: 409, code: 'ORDER_CLOSED' });
  }
  if (Number(row.slip_attempts) >= cfg.maxSlipAttempts) {
    throw new ApiError('Too many slips for this order', { status: 429, code: 'TOO_MANY_SLIPS' });
  }

  let cleanPayload = null;
  if (payload != null && payload !== '') {
    cleanPayload = String(payload).trim();
    if (!SLIP_PAYLOAD_RE.test(cleanPayload)) throw new ApiError('That slip QR could not be read', { code: 'INVALID_SLIP_PAYLOAD' });
  }
  let sniffed = null;
  if (image) {
    if (!Buffer.isBuffer(image) || image.length === 0) throw new ApiError('Attach a slip image', { code: 'SLIP_MISSING' });
    if (image.length > cfg.slipMaxBytes) throw new ApiError('That image is too large', { status: 413, code: 'FILE_TOO_LARGE' });
    sniffed = sniffMime(image);
    if (!SLIP_MIMES.includes(sniffed.mime)) {
      throw new ApiError('A slip must be a JPEG, PNG or WebP image', { status: 415, code: 'UNSUPPORTED_TYPE' });
    }
  }
  if (!image && !cleanPayload) throw new ApiError('Attach a slip image', { code: 'SLIP_MISSING' });
  if (!image && cfg.provider === 'manual') {
    throw new ApiError('Attach the slip image so an admin can check it', { code: 'SLIP_MISSING' });
  }

  // Keep the slip (a private file) whatever happens next: an admin reviewing
  // the order should see what was sent, duplicates included.
  const sha = image ? crypto.createHash('sha256').update(image).digest('hex') : null;
  let file = null;
  if (image) {
    file = await storeFile({
      buffer: image, originalName: `slip-${orderId}.${sniffed.ext || 'jpg'}`, declaredMime: sniffed.mime,
      category: 'misc', uploaderId: userId, visibility: 'private', skipVariants: true
    });
    await addReference(file.id);
    if (row.slip_file_id && row.slip_file_id !== file.id) await releaseReference(row.slip_file_id);
  }
  await runQuery(
    `UPDATE payment_orders
        SET slip_file_id = COALESCE(?, slip_file_id), slip_sha256 = COALESCE(?, slip_sha256),
            slip_payload = COALESCE(?, slip_payload), slip_submitted_at = ${sql.now},
            slip_attempts = slip_attempts + 1, check_code = NULL, updated_at = ${sql.now},
            -- a slip for an expired order reopens it for review
            status = CASE WHEN status = 'expired' THEN 'pending' ELSE status END
      WHERE id = ?`,
    [file?.id ?? null, sha, cleanPayload, orderId]
  );

  // Replay checks that need no provider: the same image or the same slip
  // reference already paid another order.
  const qrRef = cleanPayload ? parseSlipQr(cleanPayload)?.transRef ?? null : null;
  if (sha || qrRef) {
    const dup = await getQuery(
      `SELECT id FROM payment_orders WHERE id <> ? AND status = 'paid' AND (${sha ? 'slip_sha256 = ?' : '0 = 1'} OR ${qrRef ? 'trans_ref = ?' : '0 = 1'})`,
      [orderId, ...(sha ? [sha] : []), ...(qrRef ? [qrRef] : [])]
    );
    if (dup) {
      const updated = await recordCheck(orderId, 'SLIP_DUPLICATE', cfg);
      return { order: updated, result: 'failed', check_code: 'SLIP_DUPLICATE' };
    }
  }

  const verdict = await verifySlip({
    cfg, image: image ? { buffer: image, mime: sniffed.mime } : null, payload: cleanPayload, fetchImpl
  });
  if (verdict.status === 'manual') return { order: await getOrderRow(orderId), result: 'review', check_code: null };
  if (verdict.status === 'unavailable') {
    return { order: await recordCheck(orderId, 'SLIP_REVIEW', cfg), result: 'review', check_code: 'SLIP_REVIEW', detail: verdict.detail };
  }
  if (verdict.status === 'invalid') {
    return { order: await recordCheck(orderId, verdict.code, cfg), result: 'failed', check_code: verdict.code };
  }
  const fresh = await getOrderRow(orderId);
  const problem = checkSlipAgainstOrder(verdict.slip, fresh, cfg);
  if (problem) return { order: await recordCheck(orderId, problem, cfg), result: 'failed', check_code: problem };
  try {
    const paid = await markPaid({
      orderId, transRef: verdict.slip.transRef, paidAmountSatang: verdict.slip.amountSatang, via: cfg.provider
    });
    if (!paid) {
      const now = await getOrderRow(orderId);
      if (now.status === 'paid') return { order: now, result: 'paid', check_code: null };
      throw new ApiError('This order can no longer be paid', { status: 409, code: 'ORDER_CLOSED' });
    }
    return { order: paid, result: 'paid', check_code: null, newlyPaid: true };
  } catch (err) {
    if (err?.code !== 'SLIP_DUPLICATE') throw err;
    return { order: await recordCheck(orderId, 'SLIP_DUPLICATE', cfg), result: 'failed', check_code: 'SLIP_DUPLICATE' };
  }
}

// --- admin ----------------------------------------------------------------------------

const cleanReason = (reason) => String(reason ?? '').trim().slice(0, 300) || null;

export async function approveOrder({ orderId, actorId, reason = null, transRef = null }) {
  const row = await getOrderRow(orderId);
  if (!row) throw ApiError.notFound('Order');
  if (row.status === 'paid') throw new ApiError('This order is already paid', { status: 409, code: 'ALREADY_PAID' });
  if (row.status === 'refunded') throw new ApiError('This order was refunded', { status: 409, code: 'ORDER_CLOSED' });
  const ref = transRef ? String(transRef).trim().slice(0, 64) : (row.slip_payload ? parseSlipQr(row.slip_payload)?.transRef ?? null : null);
  const paid = await markPaid({
    orderId, actorId, transRef: ref, via: 'admin', note: cleanReason(reason), from: ['pending', 'expired', 'rejected']
  });
  if (!paid) throw ApiError.conflict('The order changed — reload and try again');
  return paid;
}

export async function rejectOrder({ orderId, actorId, reason }) {
  const why = cleanReason(reason);
  if (!why) throw new ApiError('Give a reason — the payer will see it', { code: 'REASON_REQUIRED' });
  const row = await getOrderRow(orderId);
  if (!row) throw ApiError.notFound('Order');
  const res = await runQuery(
    `UPDATE payment_orders SET status = 'rejected', note = ?, reviewed_by = ?, updated_at = ${sql.now}
      WHERE id = ? AND status IN ('pending','expired')`, [why, actorId, orderId]
  );
  if (!res.changes) throw new ApiError('Only an unpaid order can be rejected', { status: 409, code: 'ORDER_CLOSED' });
  await audit({ actorId, action: 'payment_reject', targetType: 'payment', targetId: orderId,
    details: { reason: why, user_id: row.user_id, amount_satang: Number(row.amount_satang) } });
  return getOrderRow(orderId);
}

export const ADMIN_STATUSES = ['pending', 'verifying', 'paid', 'rejected', 'expired', 'refunded'];

export async function adminList({ status = null, method = null, q = null, limit = 50 } = {}, cfg) {
  const where = [];
  const params = [];
  if (status === 'verifying') where.push(`o.status = 'pending' AND o.slip_submitted_at IS NOT NULL`);
  else if (status && ADMIN_STATUSES.includes(status)) { where.push('o.status = ?'); params.push(status); }
  if (method === 'promptpay' || method === 'stripe') { where.push('o.method = ?'); params.push(method); }
  if (q) {
    const needle = `%${String(q).trim().slice(0, 64).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(o.id = ? OR u.username ${sql.like} ? ESCAPE '\\' OR u.display_name ${sql.like} ? ESCAPE '\\' OR o.trans_ref = ?)`);
    params.push(String(q).trim(), needle, needle, String(q).trim());
  }
  const rows = await allQuery(
    `SELECT o.*, u.username, u.display_name,
            (SELECT d.id FROM payment_orders d WHERE d.id <> o.id AND d.slip_sha256 = o.slip_sha256
               AND o.slip_sha256 IS NOT NULL LIMIT 1) AS duplicate_of
       FROM payment_orders o LEFT JOIN users u ON u.id = o.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (CASE WHEN o.status = 'pending' AND o.slip_submitted_at IS NOT NULL THEN 0 ELSE 1 END), o.created_at DESC, o.id DESC
      LIMIT ${Math.min(200, Math.max(1, Number(limit) || 50))}`,
    params
  );
  const totals = await getQuery(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'paid' THEN COALESCE(paid_amount_satang, amount_satang) ELSE 0 END), 0) AS paid_satang,
       COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0) AS paid_count,
       COALESCE(SUM(CASE WHEN status = 'pending' AND slip_submitted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS awaiting_review,
       COUNT(DISTINCT CASE WHEN status = 'paid' THEN user_id END) AS supporters
     FROM payment_orders`
  );
  return {
    orders: rows.map((r) => shapeOrder(r, cfg, { admin: true })),
    totals: {
      paid_satang: Number(totals?.paid_satang ?? 0),
      paid_count: Number(totals?.paid_count ?? 0),
      awaiting_review: Number(totals?.awaiting_review ?? 0),
      supporters: Number(totals?.supporters ?? 0)
    }
  };
}

// --- expiry ---------------------------------------------------------------------------

/** Expire unpaid orders past their time that have no slip waiting. Returns the rows. */
export async function sweepExpired() {
  const due = await allQuery(
    `SELECT id, user_id FROM payment_orders
      WHERE status = 'pending' AND slip_submitted_at IS NULL AND expires_at < ${sql.now} LIMIT 500`
  );
  const out = [];
  for (const row of due) {
    const res = await runQuery(
      `UPDATE payment_orders SET status = 'expired', updated_at = ${sql.now}
        WHERE id = ? AND status = 'pending' AND slip_submitted_at IS NULL`, [row.id]
    );
    if (res.changes) out.push(await getOrderRow(row.id));
  }
  return out;
}

// --- Stripe webhook -------------------------------------------------------------------

/**
 * Apply one verified Stripe event. Idempotent on event id: the event row and
 * its effect commit together, so a redelivery is a no-op and a failure is
 * retried by Stripe. Returns { duplicate, order, newlyPaid }.
 */
export async function applyStripeEvent(event) {
  const id = String(event?.id ?? '');
  const type = String(event?.type ?? '');
  if (!/^evt_[A-Za-z0-9_]+$/.test(id)) throw new ApiError('Malformed event', { code: 'BAD_EVENT' });
  const obj = event?.data?.object ?? {};
  let orderId = null;
  let effect = null;
  if (type.startsWith('checkout.session.')) {
    orderId = obj.client_reference_id ?? obj.metadata?.order_id ?? null;
    if (type === 'checkout.session.async_payment_succeeded'
      || (type === 'checkout.session.completed' && obj.payment_status === 'paid')) effect = 'paid';
    else if (type === 'checkout.session.async_payment_failed') effect = 'failed';
    else if (type === 'checkout.session.expired') effect = 'expired';
  } else if (type === 'charge.refunded' && obj.refunded) {
    effect = 'refunded';
  }

  let duplicate = false;
  let newlyPaid = false;
  let order = null;
  await transaction(async () => {
    const ins = await runQuery(
      `INSERT INTO payment_events (id, provider, type, order_id) VALUES (?, 'stripe', ?, ?) ON CONFLICT DO NOTHING`,
      [id, type, orderId]
    );
    if (!ins.changes) { duplicate = true; return; }
    if (effect === 'refunded') {
      const intent = String(obj.payment_intent ?? '');
      const row = intent ? await getQuery(`SELECT * FROM payment_orders WHERE trans_ref = ? AND method = 'stripe'`, [intent]) : null;
      if (!row) return;
      orderId = row.id;
      const res = await runQuery(
        `UPDATE payment_orders SET status = 'refunded', note = 'Refunded', updated_at = ${sql.now} WHERE id = ? AND status = 'paid'`, [row.id]
      );
      if (res.changes) {
        await refreshSupporter(row.user_id);
        await audit({ actorId: null, action: 'payment_refund', targetType: 'payment', targetId: row.id,
          details: { via: 'stripe', user_id: row.user_id } });
      }
      return;
    }
    if (!orderId) return;
    const row = await getQuery(`SELECT * FROM payment_orders WHERE id = ? AND method = 'stripe'`, [String(orderId)]);
    if (!row || (row.provider_ref && obj.id && row.provider_ref !== obj.id)) return;
    if (effect === 'paid') {
      const amount = Number(obj.amount_total);
      if (String(obj.currency ?? 'thb').toLowerCase() !== 'thb' || !(amount >= Number(row.amount_satang))) return;
      const paid = await markPaid({
        orderId: row.id, transRef: obj.payment_intent ? String(obj.payment_intent) : null,
        paidAmountSatang: amount, via: 'stripe'
      });
      newlyPaid = Boolean(paid);
    } else if (effect === 'failed' || effect === 'expired') {
      await runQuery(
        `UPDATE payment_orders SET status = ?, note = ?, updated_at = ${sql.now} WHERE id = ? AND status = 'pending'`,
        [effect === 'failed' ? 'rejected' : 'expired', effect === 'failed' ? 'The payment did not go through' : null, row.id]
      );
    }
  });
  if (orderId) order = await getOrderRow(orderId);
  return { duplicate, order, newlyPaid };
}

/** After a refund: keep the badge only while another paid order remains. */
async function refreshSupporter(userId) {
  if (!userId) return;
  const left = await getQuery(`SELECT MIN(paid_at) AS first FROM payment_orders WHERE user_id = ? AND status = 'paid'`, [userId]);
  await runQuery(`UPDATE users SET supporter_since = ? WHERE id = ?`, [left?.first ?? null, userId]);
}

// --- supporter preferences --------------------------------------------------------------

export async function supporterStatus(userId) {
  const row = await getQuery(`SELECT supporter_since, supporter_badge_hidden FROM users WHERE id = ?`, [userId]);
  return { supporter_since: row?.supporter_since ?? null, badge_hidden: Boolean(Number(row?.supporter_badge_hidden ?? 0)) };
}

export async function setSupporterBadgeHidden(userId, hidden) {
  await runQuery(`UPDATE users SET supporter_badge_hidden = ? WHERE id = ?`, [hidden ? 1 : 0, userId]);
  return supporterStatus(userId);
}
