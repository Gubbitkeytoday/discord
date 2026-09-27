// ============================================================================
//  Bank slip verification behind one interface.
//
//    verifySlip({ cfg, image, payload, fetchImpl }) →
//      { status: 'verified', slip }    the provider says the slip is genuine;
//                                      `slip` is normalised (see below)
//      { status: 'invalid', code }     not a genuine / readable slip
//      { status: 'unavailable' }       provider down, quota used up, bad key…
//                                      → the order waits for an admin instead
//      { status: 'manual' }            no provider configured
//
//    slip = { transRef, amountSatang, transAt (ISO), sendingBank,
//             receiver: { proxy, account, name } }   (proxy/account masked)
//
//  A "genuine" slip is not yet a payment to US for THIS order — that is
//  checkSlipAgainstOrder(): receiver matches our PromptPay id (masked
//  comparison), amount ≥ order, transaction after the order was created and
//  within 24 h. The transaction reference must also be unused, which the
//  UNIQUE index on payment_orders.trans_ref enforces (services/payments/orders.js).
//
//  Provider HTTP details live in ONE function each (slipokRequest,
//  easyslipRequest). They were written from the providers' public docs and
//  their published client libraries (slipok / @prakrit_m/slipok-sdk and
//  n8n-nodes-easyslip on npm) because the documentation sites were not
//  reachable from the build environment; they have not been exercised
//  against the live APIs. The tests drive them through a mock.
// ============================================================================

import { maskedMatches, receiverCandidates } from './promptpay.js';

const TIMEOUT_MS = 15_000;
const CLOCK_SKEW_MS = 2 * 60_000;

const toSatang = (value) => {
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '')) : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

/** A Bangkok wall-clock date (yyyyMMdd + HH:mm:ss) as an ISO instant. */
function bangkokToIso(date, time) {
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(String(date ?? ''));
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(time ?? ''));
  if (!d || !t) return null;
  const iso = `${d[1]}-${d[2]}-${d[3]}T${t[1]}:${t[2]}:${t[3] ?? '00'}+07:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const isoOrNull = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

async function withTimeout(fetchImpl, url, init, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function imageForm(field, image) {
  const form = new FormData();
  const ext = (image.mime ?? 'image/jpeg').split('/')[1] ?? 'jpg';
  form.append(field, new Blob([image.buffer], { type: image.mime ?? 'image/jpeg' }), `slip.${ext}`);
  return form;
}

// --- SlipOK -------------------------------------------------------------------------
//   POST https://api.slipok.com/api/line/apikey/<BRANCH_ID>
//   x-authorization: <API_KEY>
//   multipart `files` (image)  or  JSON { data: "<slip QR payload>" }
//   200 { success: true, data: { success, transRef, transDate: 'yyyyMMdd',
//         transTime: 'HH:mm:ss', transTimestamp, amount, sendingBank,
//         receiver: { displayName, name, proxy: { type, value }, account: { type, value } } } }
//   4xx { code: 1000…1014, message }

const SLIPOK_INVALID = new Set([1005, 1006, 1007, 1008, 1011]);

export async function slipokRequest({ cfg, image, payload, fetchImpl }) {
  const base = cfg.providerBaseOverride ?? 'https://api.slipok.com';
  const url = `${base}/api/line/apikey/${encodeURIComponent(cfg.slipok.branchId)}`;
  const headers = { 'x-authorization': cfg.slipok.apiKey };
  let body;
  if (payload) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ data: payload });
  } else {
    body = imageForm('files', image);
  }
  const res = await withTimeout(fetchImpl, url, { method: 'POST', headers, body });
  const b = res.body;
  if (res.status === 200 && b?.success === true && b.data) {
    const d = b.data;
    return {
      status: 'verified',
      slip: {
        transRef: d.transRef ? String(d.transRef) : null,
        amountSatang: toSatang(d.amount),
        transAt: isoOrNull(d.transTimestamp) ?? bangkokToIso(d.transDate, d.transTime),
        sendingBank: d.sendingBank ?? null,
        receiver: {
          proxy: d.receiver?.proxy?.value ?? null,
          account: d.receiver?.account?.value ?? null,
          name: d.receiver?.displayName ?? d.receiver?.name ?? null
        }
      }
    };
  }
  const code = Number(b?.code);
  if (SLIPOK_INVALID.has(code)) return { status: 'invalid', code: 'SLIP_NOT_VERIFIED', detail: `slipok:${code}` };
  return { status: 'unavailable', detail: `slipok:${Number.isFinite(code) ? code : res.status}` };
}

// --- EasySlip -----------------------------------------------------------------------
//   POST https://developer.easyslip.com/api/v1/verify   multipart `file`
//   GET  https://developer.easyslip.com/api/v1/verify?payload=<slip QR payload>
//   Authorization: Bearer <EASYSLIP_API_KEY>
//   200 { status: 200, data: { transRef, date (ISO), amount: { amount },
//         sender: {…}, receiver: { bank: { id }, account: { name: { th, en },
//         bank: { type, account }, proxy: { type, account } } } } }
//   4xx { status, message: 'invalid_payload' | 'slip_not_found' | 'qrcode_not_found' | … }

const EASYSLIP_INVALID = new Set(['invalid_payload', 'invalid_image', 'slip_not_found', 'qrcode_not_found']);

export async function easyslipRequest({ cfg, image, payload, fetchImpl }) {
  const base = cfg.providerBaseOverride ?? 'https://developer.easyslip.com';
  const headers = { Authorization: `Bearer ${cfg.easyslip.apiKey}` };
  const res = payload
    ? await withTimeout(fetchImpl, `${base}/api/v1/verify?payload=${encodeURIComponent(payload)}`, { method: 'GET', headers })
    : await withTimeout(fetchImpl, `${base}/api/v1/verify`, { method: 'POST', headers, body: imageForm('file', image) });
  const b = res.body;
  const d = b?.data;
  if (res.status === 200 && d && (Number(b.status) === 200 || b.success === true)) {
    const acc = d.receiver?.account ?? {};
    return {
      status: 'verified',
      slip: {
        transRef: d.transRef ?? d.reference ?? null,
        amountSatang: toSatang(typeof d.amount === 'object' ? d.amount?.amount : d.amount),
        transAt: isoOrNull(d.date ?? d.transactionDate),
        sendingBank: d.sender?.bank?.id ?? null,
        receiver: {
          proxy: acc.proxy?.account ?? null,
          account: acc.bank?.account ?? null,
          name: acc.name?.th ?? acc.name?.en ?? null
        }
      }
    };
  }
  const message = String(b?.message ?? '');
  if (EASYSLIP_INVALID.has(message)) return { status: 'invalid', code: 'SLIP_NOT_VERIFIED', detail: `easyslip:${message}` };
  return { status: 'unavailable', detail: `easyslip:${message || res.status}` };
}

const PROVIDERS = { slipok: slipokRequest, easyslip: easyslipRequest };

export async function verifySlip({ cfg, image = null, payload = null, fetchImpl = globalThis.fetch }) {
  const request = PROVIDERS[cfg.provider];
  if (!request) return { status: 'manual' };
  if (!image && !payload) return { status: 'invalid', code: 'SLIP_MISSING' };
  try {
    const result = await request({ cfg, image, payload, fetchImpl });
    if (result.status === 'verified' && (!result.slip.transRef || !result.slip.amountSatang || !result.slip.transAt)) {
      // Genuine by the provider's word, but without the facts we check.
      return { status: 'unavailable', detail: `${cfg.provider}:incomplete` };
    }
    return result;
  } catch (err) {
    return { status: 'unavailable', detail: `${cfg.provider}:${err?.name === 'AbortError' ? 'timeout' : 'network'}` };
  }
}

/**
 * Is this genuine slip a payment for `order`? Returns null when it is, or an
 * error code: SLIP_WRONG_RECEIVER, SLIP_UNDERPAID, SLIP_TOO_OLD, SLIP_TOO_EARLY.
 */
export function checkSlipAgainstOrder(slip, order, cfg, now = Date.now()) {
  const candidates = receiverCandidates(cfg.promptPayId);
  const proxyOk = slip.receiver?.proxy && maskedMatches(slip.receiver.proxy, candidates);
  const accountOk = slip.receiver?.account
    && (maskedMatches(slip.receiver.account, cfg.receiverAccounts) || maskedMatches(slip.receiver.account, candidates));
  if (!proxyOk && !accountOk) return 'SLIP_WRONG_RECEIVER';
  if (!(slip.amountSatang >= Number(order.amount_satang))) return 'SLIP_UNDERPAID';
  const at = Date.parse(slip.transAt);
  const created = Date.parse(order.created_at);
  if (!Number.isFinite(at) || at < created - CLOCK_SKEW_MS) return 'SLIP_TOO_EARLY';
  if (at > now + CLOCK_SKEW_MS || now - at > cfg.slipWindowMs || at - created > cfg.slipWindowMs) return 'SLIP_TOO_OLD';
  return null;
}
