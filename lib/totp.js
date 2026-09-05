// ============================================================================
//  TOTP (RFC 6238) — two-factor authentication with no dependencies.
//
//  HMAC-SHA1 over a 30-second counter, which is what every authenticator app
//  (Google Authenticator, Authy, 1Password, Aegis) implements. Verified against
//  the RFC's published test vectors in the test suite.
// ============================================================================

import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const DEFAULT_PERIOD = 30;
export const DEFAULT_DIGITS = 6;
// Accept the neighbouring windows: phone clocks drift, and a code typed at the
// boundary of a period would otherwise fail for no user-visible reason.
export const DEFAULT_WINDOW = 1;

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const cleaned = String(input).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`ตัวอักษร base32 ไม่ถูกต้อง: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, base32-encoded as authenticator apps expect. */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/**
 * One TOTP code.
 * @param secret base32 secret
 * @param options.timestamp ms since epoch (defaults to now)
 * @param options.algorithm sha1 | sha256 | sha512
 */
export function generateCode(secret, {
  timestamp = Date.now(), period = DEFAULT_PERIOD, digits = DEFAULT_DIGITS, algorithm = 'sha1'
} = {}) {
  const counter = Math.floor(timestamp / 1000 / period);

  // 8-byte big-endian counter. BigInt keeps it correct past 2038.
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac(algorithm, base32Decode(secret)).update(buffer).digest();

  // Dynamic truncation, per RFC 4226 §5.4.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Check a user-supplied code against the current window and its neighbours.
 * Comparison is constant-time so response timing cannot be used as an oracle.
 */
export function verifyCode(secret, code, {
  timestamp = Date.now(), period = DEFAULT_PERIOD, digits = DEFAULT_DIGITS,
  window = DEFAULT_WINDOW, algorithm = 'sha1'
} = {}) {
  const candidate = String(code ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return false;

  for (let drift = -window; drift <= window; drift += 1) {
    const expected = generateCode(secret, {
      timestamp: timestamp + drift * period * 1000, period, digits, algorithm
    });
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** otpauth:// URI for the QR code an authenticator app scans. */
export function buildOtpAuthUri({ secret, accountName, issuer = 'Antigravity Discord', digits = DEFAULT_DIGITS, period = DEFAULT_PERIOD }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(period)
  });
  return `otpauth://totp/${label}?${params}`;
}

/**
 * Recovery codes, for when the phone is lost.
 * Returned in plaintext once; only hashes are stored.
 */
export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export const hashRecoveryCode = (code) =>
  crypto.createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
