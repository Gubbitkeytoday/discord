// ============================================================================
//  Passkeys, client side. Thin wrappers around /api/passkeys/* and
//  @simplewebauthn/browser, which is loaded lazily on first use so it costs
//  nothing for people who never touch a passkey.
//
//    signInWithPasskey()                    button: "Sign in with a passkey"
//    signInWithPasskey({ conditional })     autofill (conditional UI) on the
//                                           username field
//    registerPasskey(name) / listPasskeys() / renamePasskey() / deletePasskey()
//    reauthWithPassword() / reauthWithPasskey() / getReauthStatus()
// ============================================================================

import { get, post, patch, del } from '../api';

const loadLib = () => import('@simplewebauthn/browser');

let configPromise = null;

/** { enabled, rp_id } from the server, fetched once per page load. */
export function getPasskeyConfig() {
  configPromise ??= get('/api/passkeys/config').catch(() => ({ enabled: false, rp_id: null }));
  return configPromise;
}

/** WebAuthn is present at all (secure context, modern browser). */
export function browserSupportsPasskeys() {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential === 'function'
    && Boolean(navigator.credentials?.get);
}

/** Server enabled + browser capable: whether to show any passkey UI. */
export async function passkeysAvailable() {
  if (!browserSupportsPasskeys()) return false;
  const cfg = await getPasskeyConfig();
  return Boolean(cfg?.enabled);
}

/** Conditional UI (passkeys offered in the username field's autofill). */
export async function conditionalUiAvailable() {
  if (!(await passkeysAvailable())) return false;
  try {
    return Boolean(await window.PublicKeyCredential.isConditionalMediationAvailable?.());
  } catch {
    return false;
  }
}

/** Stop a pending ceremony (e.g. the autofill one when the form is submitted). */
export async function cancelPasskeyCeremony() {
  try {
    const { WebAuthnAbortService } = await loadLib();
    WebAuthnAbortService.cancelCeremony();
  } catch { /* nothing pending */ }
}

/**
 * The browser's "user dismissed the sheet" and "aborted" errors are not
 * failures worth a red banner; mark them so callers can stay quiet.
 */
function normalizeError(err) {
  const name = err?.name;
  const code = err?.code;
  if (name === 'NotAllowedError' || name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED') {
    const quiet = new Error(err?.message || 'cancelled');
    quiet.code = 'PASSKEY_CANCELLED';
    quiet.cancelled = true;
    return quiet;
  }
  if (name === 'InvalidStateError' || code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
    const dup = new Error(err?.message || 'already registered');
    dup.code = 'PASSKEY_EXISTS';
    return dup;
  }
  return err;
}

/**
 * Sign in. Resolves to the same `{ user, token, expires_at }` a password login
 * returns. With `conditional: true` this waits (possibly forever) for the user
 * to pick a passkey from the username field's autofill; the field must carry
 * autocomplete="username webauthn".
 */
export async function signInWithPasskey({ conditional = false, device = null } = {}) {
  const { startAuthentication } = await loadLib();
  const { flow_id: flowId, options } = await post('/api/passkeys/login/options', {});
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: conditional });
  } catch (err) {
    throw normalizeError(err);
  }
  return post('/api/passkeys/login/verify', { flow_id: flowId, response, device });
}

// --- step-up ---------------------------------------------------------------------

export const getReauthStatus = () => get('/api/passkeys/reauth');

export const reauthWithPassword = ({ password, code } = {}) =>
  post('/api/passkeys/reauth/password', { password, ...(code ? { code } : {}) });

export async function reauthWithPasskey() {
  const { startAuthentication } = await loadLib();
  const { flow_id: flowId, options } = await post('/api/passkeys/reauth/options', {});
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    throw normalizeError(err);
  }
  return post('/api/passkeys/reauth/verify', { flow_id: flowId, response });
}

// --- management -------------------------------------------------------------------

export const listPasskeys = () => get('/api/passkeys');
export const renamePasskey = (id, name) => patch(`/api/passkeys/${encodeURIComponent(id)}`, { name });
export const deletePasskey = (id) => del(`/api/passkeys/${encodeURIComponent(id)}`);

/** Create a passkey on this device. Needs a fresh step-up (REAUTH_REQUIRED otherwise). */
export async function registerPasskey(name) {
  const { startRegistration } = await loadLib();
  const { flow_id: flowId, options } = await post('/api/passkeys/register/options', {});
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err) {
    throw normalizeError(err);
  }
  return post('/api/passkeys/register/verify', { flow_id: flowId, response, name });
}

/** A friendly default name: "Chrome on macOS". */
export function suggestPasskeyName() {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}
