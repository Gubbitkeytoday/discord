// ============================================================================
//  Payments configuration, read from the environment on every call (cheap,
//  and lets tests start a server with their own values).
//
//  Payments are OFF unless PROMPTPAY_ID is a valid PromptPay id or both
//  Stripe keys are set; with them off every /api/payments route except
//  /config answers 404 PAYMENTS_DISABLED and the client hides the feature.
// ============================================================================

import { normalizePromptPayId, maskForDisplay } from './promptpay.js';

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const SLIP_PROVIDERS = Object.freeze(['manual', 'slipok', 'easyslip']);

export function paymentsConfig(env = process.env) {
  const promptPayId = normalizePromptPayId(env.PROMPTPAY_ID) ? String(env.PROMPTPAY_ID).trim() : null;
  const stripe = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
  const minThb = int(env.PAYMENTS_MIN_THB, 20);
  const maxThb = Math.max(minThb, int(env.PAYMENTS_MAX_THB, 50_000));
  const presets = String(env.PAYMENTS_PRESETS_THB ?? '50,100,300,500')
    .split(',').map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= minThb && n <= maxThb)
    .slice(0, 6);
  let provider = String(env.SLIP_VERIFY_PROVIDER ?? 'manual').trim().toLowerCase() || 'manual';
  if (!SLIP_PROVIDERS.includes(provider)) provider = 'manual';
  // A provider without its keys cannot verify anything: fall back to review.
  if (provider === 'slipok' && !(env.SLIPOK_API_KEY && env.SLIPOK_BRANCH_ID)) provider = 'manual';
  if (provider === 'easyslip' && !env.EASYSLIP_API_KEY) provider = 'manual';
  return {
    promptPayId,
    promptPayName: String(env.PROMPTPAY_NAME ?? '').trim().slice(0, 80) || null,
    promptPayHint: promptPayId ? maskForDisplay(promptPayId) : null,
    // Bank account(s) the PromptPay id pays into — many slips show the
    // account rather than the PromptPay id. Comma-separated, digits only.
    receiverAccounts: String(env.PROMPTPAY_ACCOUNT ?? '').split(',').map((s) => s.replace(/\D/g, '')).filter((s) => s.length >= 6),
    stripe,
    enabled: Boolean(promptPayId) || stripe,
    minThb,
    maxThb,
    presets: presets.length ? presets : [50, 100, 300, 500].filter((n) => n >= minThb && n <= maxThb),
    orderTtlMs: int(env.PAYMENTS_ORDER_TTL_MIN, 30) * 60_000,
    stripeTtlMs: 60 * 60_000,
    slipMaxBytes: int(env.PAYMENTS_SLIP_MAX_BYTES, 5 * 1024 * 1024),
    slipWindowMs: 24 * 60 * 60_000,
    maxSlipAttempts: 5,
    maxOpenOrders: 3,
    provider,
    slipok: { apiKey: env.SLIPOK_API_KEY ?? null, branchId: env.SLIPOK_BRANCH_ID ?? null },
    easyslip: { apiKey: env.EASYSLIP_API_KEY ?? null },
    stripeKeys: { secret: env.STRIPE_SECRET_KEY ?? null, webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null },
    // Test / staging only: point a provider at a local mock. Ignored in
    // production so a stray variable can never redirect slips elsewhere.
    providerBaseOverride: env.NODE_ENV === 'production' ? null : (env.PAYMENTS_PROVIDER_BASE_URL || null),
    sweepMs: Math.max(1000, int(env.PAYMENTS_SWEEP_MS, 60_000))
  };
}

/** What anyone may know (GET /api/payments/config). */
export function publicConfig(cfg = paymentsConfig()) {
  if (!cfg.enabled) return { enabled: false };
  return {
    enabled: true,
    currency: 'THB',
    methods: { promptpay: Boolean(cfg.promptPayId), stripe: cfg.stripe },
    presets: cfg.presets,
    min_thb: cfg.minThb,
    max_thb: cfg.maxThb,
    receiver_name: cfg.promptPayName,
    receiver_hint: cfg.promptPayHint,
    verification: cfg.provider === 'manual' ? 'manual' : 'automatic',
    order_ttl_minutes: Math.round(cfg.orderTtlMs / 60_000),
    slip_max_bytes: cfg.slipMaxBytes
  };
}
