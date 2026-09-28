// ============================================================================
//  PromptPay / Thai QR Payment payload (EMVCo Merchant-Presented Mode).
//
//  Every field is TLV: 2-digit id, 2-digit length, value.
//
//    00 02 "01"                 payload format indicator
//    01 02 "11" | "12"          point of initiation: 11 static, 12 dynamic
//                               (dynamic = one amount, one payment)
//    29 ..                      merchant account information — PromptPay
//        00 16 A000000677010111 application id (credit transfer)
//        01 13 0066XXXXXXXXX    mobile number: leading 0 → 66, left-padded
//                               with zeros to 13 digits
//        02 13 NNNNNNNNNNNNN    national id / tax id (13 digits)
//        03 15 NNNNNNNNNNNNNNN  e-wallet id (15 digits)
//    58 02 "TH"                 country
//    53 03 "764"                currency (ISO 4217 numeric, THB)
//    54 ..  "123.45"            amount, dynamic QR only
//    63 04 XXXX                 CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF)
//                               over everything before it INCLUDING "6304",
//                               upper-case hex
//
//  The field order (58 before 53/54) follows the widely used promptpay-qr
//  library so payloads are byte-identical with what Thai banking apps have
//  been scanning for years; EMVCo does not require ascending ids.
//
//  Also: parseTlv() / parseSlipQr() read the small verification QR printed on
//  Thai bank slips (tag 00 → 00 api id, 01 sending bank, 02 transaction ref).
// ============================================================================

export const PROMPTPAY_AID = 'A000000677010111';
export const CURRENCY_THB = '764';
export const COUNTRY_TH = 'TH';

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xorout. */
export function crc16(text) {
  let crc = 0xffff;
  const bytes = Buffer.from(String(text), 'utf8');
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function field(id, value) {
  const v = String(value);
  if (v.length > 99) throw new Error(`EMV field ${id} is too long`);
  return `${id}${String(v.length).padStart(2, '0')}${v}`;
}

/**
 * Classify and normalise a PromptPay id.
 *   0XXXXXXXXX (10-digit Thai mobile)  → { type: 'phone',   value: '0066XXXXXXXXX' }
 *   66XXXXXXXXX / +66…                  → phone as well
 *   13 digits                           → { type: 'tax_id',  value }  (national id or tax id)
 *   15 digits                           → { type: 'ewallet', value }
 * Returns null for anything else.
 */
export function normalizePromptPayId(raw) {
  const digits = String(raw ?? '').replace(/[\s\-+().]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 15) return { type: 'ewallet', tag: '03', value: digits };
  if (digits.length === 13 && !digits.startsWith('0066')) return { type: 'tax_id', tag: '02', value: digits };
  let local = null;
  if (/^0\d{9}$/.test(digits)) local = digits.slice(1);
  else if (/^66\d{9}$/.test(digits)) local = digits.slice(2);
  else if (/^0066\d{9}$/.test(digits)) local = digits.slice(4);
  if (!local) return null;
  return { type: 'phone', tag: '01', value: `0066${local}`, local: `0${local}` };
}

/** Amount as the QR carries it: plain decimal with two places, e.g. "4.22". */
export function formatAmount(satang) {
  const n = Number(satang);
  if (!Number.isInteger(n) || n <= 0) throw new Error('amount must be a positive integer number of satang');
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

/**
 * The QR payload. `amountSatang` makes it dynamic (tag 54, POI "12");
 * without it the QR is static and the payer types the amount.
 */
export function buildPromptPayPayload({ id, amountSatang = null }) {
  const target = normalizePromptPayId(id);
  if (!target) throw new Error('PROMPTPAY_ID must be a Thai mobile number, a 13-digit national/tax id or a 15-digit e-wallet id');
  const parts = [
    field('00', '01'),
    field('01', amountSatang ? '12' : '11'),
    field('29', field('00', PROMPTPAY_AID) + field(target.tag, target.value)),
    field('58', COUNTRY_TH),
    field('53', CURRENCY_THB)
  ];
  if (amountSatang) parts.push(field('54', formatAmount(amountSatang)));
  const body = `${parts.join('')}6304`;
  return body + crc16(body);
}

/** Parse flat TLV into a Map id → value. Throws on malformed input. */
export function parseTlv(text) {
  const out = new Map();
  let i = 0;
  const s = String(text);
  while (i < s.length) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(len) || i + 4 + len > s.length) throw new Error('malformed TLV');
    out.set(id, s.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return out;
}

/** True when a payload's trailing 63-04 CRC is correct. */
export function hasValidCrc(payload) {
  const s = String(payload ?? '');
  if (s.length < 8 || s.slice(-8, -4) !== '6304') return false;
  return crc16(s.slice(0, -4)) === s.slice(-4).toUpperCase();
}

/**
 * The verification QR on a Thai bank slip ("mini QR"):
 *   00 → { 00 api id "000001", 01 sending bank code, 02 transaction ref }
 *   51 country "TH", 91 CRC (same CRC-16 over everything before its value).
 * Returns { transRef, sendingBank } or null. It proves nothing on its own —
 * anyone can type one — but its reference feeds the replay check, and the
 * slip providers accept it in place of the image.
 */
export function parseSlipQr(payload) {
  const s = String(payload ?? '').trim();
  if (s.length < 20 || s.length > 512 || !/^[0-9A-Za-z]+$/.test(s)) return null;
  try {
    const top = parseTlv(s);
    const inner = top.get('00');
    if (!inner) return null;
    const tags = parseTlv(inner);
    const transRef = tags.get('02');
    if (!transRef || !/^[0-9A-Za-z]{6,40}$/.test(transRef)) return null;
    if (top.has('91')) {
      const crc = top.get('91');
      if (crc16(s.slice(0, -4)) !== String(crc).toUpperCase()) return null;
    }
    return { transRef, sendingBank: tags.get('01') ?? null };
  } catch {
    return null;
  }
}

/**
 * Masked receiver comparison. Providers return the receiver's PromptPay id or
 * account number masked ("xxx-xxx-5678", "081-xxx-5678", "XXX-X-X1234-X").
 * A value matches one of `candidates` when, aligned from the right, every
 * digit it shows equals ours — and it shows at least 3 digits, so a fully
 * masked value never passes.
 */
export function maskedMatches(masked, candidates) {
  const m = String(masked ?? '').replace(/[\s\-.]/g, '').toUpperCase().replace(/[*•●#]/g, 'X');
  if (!m || !/^[0-9X]+$/.test(m)) return false;
  const visible = (m.match(/\d/g) ?? []).length;
  if (visible < 3) return false;
  return candidates.some((raw) => {
    const c = String(raw ?? '').replace(/\D/g, '');
    if (!c || m.length > c.length) return false;
    const tail = c.slice(c.length - m.length);
    for (let i = 0; i < m.length; i += 1) {
      if (m[i] !== 'X' && m[i] !== tail[i]) return false;
    }
    return true;
  });
}

/** Every spelling of our id a provider might mask. */
export function receiverCandidates(promptPayId) {
  const t = normalizePromptPayId(promptPayId);
  if (!t) return [];
  if (t.type === 'phone') return [t.local, t.value, t.value.slice(2)];
  return [t.value];
}

/** "081-xxx-5678" style hint that is safe to show publicly. */
export function maskForDisplay(promptPayId) {
  const t = normalizePromptPayId(promptPayId);
  if (!t) return null;
  const v = t.type === 'phone' ? t.local : t.value;
  return `${'•'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
}
