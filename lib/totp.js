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
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
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

/**
 * Like verifyCode, but returns the time step (counter) the code belongs to, or
 * null. The caller records accepted steps so one code cannot be used twice —
 * RFC 6238 §5.2: "the verifier MUST NOT accept the second attempt of the OTP
 * after the successful validation has been issued for the first OTP".
 */
export function matchCodeStep(secret, code, {
  timestamp = Date.now(), period = DEFAULT_PERIOD, digits = DEFAULT_DIGITS,
  window = DEFAULT_WINDOW, algorithm = 'sha1'
} = {}) {
  const candidate = String(code ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return null;
  let matched = null;
  // Check every step in the window (no early exit), so timing does not reveal
  // which one matched.
  for (let drift = -window; drift <= window; drift += 1) {
    const at = timestamp + drift * period * 1000;
    const expected = generateCode(secret, { timestamp: at, period, digits, algorithm });
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    if (a.length === b.length && crypto.timingSafeEqual(a, b) && matched === null) {
      matched = Math.floor(at / 1000 / period);
    }
  }
  return matched;
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
 * Returned in plaintext once; only a slow, keyed derivation is stored.
 *
 * Ten Crockford base32 characters (no I, L, O or U) = 50 bits each, shown as
 * XXXXX-XXXXX. Typing is forgiving: case, spaces, dashes and the look-alikes
 * O→0, I/L→1 are normalised away.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_LENGTH = 10;

export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = crypto.randomBytes(RECOVERY_CODE_LENGTH);
    // 256 is a multiple of 32, so `byte & 31` is uniform.
    const raw = Array.from(bytes, (b) => CROCKFORD[b & 31]).join('');
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/** The canonical form a code is derived from, or null if it cannot be one. */
export function normaliseRecoveryCode(code) {
  const cleaned = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  return cleaned.length === RECOVERY_CODE_LENGTH ? cleaned : null;
}

// scrypt (memory-hard) with a server-side pepper as the salt. The salt must be
// fixed, not per row: the derived value is the lookup key of the atomic
// "burn once" UPDATE. 2^14 × 8 costs ~16 MiB and a few tens of ms per code,
// so a leaked table cannot be searched cheaply, and without the pepper
// (MFA_RECOVERY_PEPPER, kept out of the database) not at all.
const RECOVERY_SCRYPT = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const RECOVERY_HASH_PREFIX = 'rc2$';

function recoveryPepper() {
  return `antigravity/mfa-recovery/v2\0${process.env.MFA_RECOVERY_PEPPER ?? ''}`;
}

/**
 * Stored form of a recovery code: `rc2$` + hex scrypt output. Resolves to
 * null for input that cannot be a recovery code (a mistyped TOTP code), so
 * no work is spent on it.
 */
export function hashRecoveryCode(code) {
  const normalised = normaliseRecoveryCode(code);
  if (!normalised) return Promise.resolve(null);
  return scryptHex(normalised).then((hex) => `${RECOVERY_HASH_PREFIX}${hex}`);
}

function scryptHex(input) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(input, recoveryPepper(), 32, RECOVERY_SCRYPT, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

// --- codes issued before rc2 ---------------------------------------------------
//
// Older releases stored SHA-256(code) (10 hex characters, 40 bits). Those rows
// are re-hashed in place, without the plaintext, to `rc1w$` + scrypt(digest)
// the next time their owner meets an MFA check, so a leaked table holds no
// fast hashes; each code keeps working until it is burned.
export const LEGACY_WRAPPED_PREFIX = 'rc1w$';

/** Wrap a stored legacy SHA-256 digest (hex) in the slow keyed derivation. */
export async function wrapLegacyRecoveryHash(digestHex) {
  return `${LEGACY_WRAPPED_PREFIX}${await scryptHex(String(digestHex))}`;
}

/** The wrapped form of a legacy (hex) code as typed, or null if it cannot be one. */
export async function legacyRecoveryHash(code) {
  const cleaned = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[0-9A-F]{10}$/.test(cleaned)) return null;
  return wrapLegacyRecoveryHash(crypto.createHash('sha256').update(cleaned).digest('hex'));
}
