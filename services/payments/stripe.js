// ============================================================================
//  Stripe (optional): Checkout Sessions over plain HTTPS to the fixed host
//  api.stripe.com, and webhook signature verification. No SDK.
//
//  Enabled only when STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are both set.
//  Payment methods: card + promptpay, currency thb. PromptPay through Stripe
//  is asynchronous: checkout.session.completed arrives with payment_status
//  'unpaid' and checkout.session.async_payment_succeeded follows.
// ============================================================================

import crypto from 'node:crypto';

export const STRIPE_API = 'https://api.stripe.com';
export const SIGNATURE_TOLERANCE_S = 300;

/** Stripe's form encoding: nested keys as a[b][0][c]=v. */
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

/**
 * Create a Checkout Session for an order. Returns { id, url, expires_at }.
 * `fetchImpl` is injectable for tests; the host is never configurable.
 */
export async function createCheckoutSession({ secretKey, order, publicUrl, productName, fetchImpl = globalThis.fetch }) {
  const base = String(publicUrl ?? '').replace(/\/$/, '');
  const expiresAt = Math.floor(Date.parse(order.expires_at) / 1000);
  const body = formEncode({
    mode: 'payment',
    payment_method_types: { 0: 'card', 1: 'promptpay' },
    client_reference_id: order.id,
    metadata: { order_id: order.id, user_id: order.user_id },
    payment_intent_data: { metadata: { order_id: order.id } },
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: 'thb',
          unit_amount: Number(order.amount_satang),
          product_data: { name: productName || 'Support this instance' }
        }
      }
    },
    expires_at: expiresAt,
    success_url: `${base}/?payment=${encodeURIComponent(order.id)}&result=success`,
    cancel_url: `${base}/?payment=${encodeURIComponent(order.id)}&result=cancel`
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(`${STRIPE_API}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `order-${order.id}`
      },
      body: body.toString(),
      signal: controller.signal,
      redirect: 'error'
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.id || !json?.url) {
      const err = new Error(json?.error?.message || `Stripe answered ${res.status}`);
      err.code = 'STRIPE_UNAVAILABLE';
      throw err;
    }
    return { id: json.id, url: json.url, expires_at: json.expires_at ?? expiresAt };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a `Stripe-Signature` header over the RAW request body.
 *   header: t=<unix>,v1=<hex hmac>[,v1=…][,v0=…]
 *   signed: `${t}.${rawBody}` with HMAC-SHA256 keyed by the endpoint secret
 * Any v1 may match (secret rotation); constant-time; |now - t| ≤ 5 min.
 */
export function verifyStripeSignature({ rawBody, header, secret, now = Date.now(), toleranceS = SIGNATURE_TOLERANCE_S }) {
  if (!Buffer.isBuffer(rawBody) || !header || !secret) return false;
  let timestamp = null;
  const signatures = [];
  for (const part of String(header).split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s?.trim());
    if (k === 't' && /^\d+$/.test(v ?? '')) timestamp = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v ?? '')) signatures.push(v.toLowerCase());
  }
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > toleranceS) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

/** Build a header the way Stripe does — for tests and local tooling. */
export function signStripePayload({ rawBody, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}
