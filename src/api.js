// ============================================================================
//  Tiny fetch wrapper shared by every component.
//
//  - Same-origin, cookie-backed sessions (the session cookie is HttpOnly).
//  - JSON in, JSON out; a non-2xx response throws an Error carrying the server's
//    message and `code`, so callers can `catch` and toast without inspecting
//    status codes.
//  - The acting user id is attached as `x-user-id` for the dev identity mode;
//    the server ignores it whenever a real session is present.
// ============================================================================

import { t } from './i18n/index.jsx';

let currentUserId = null;
let bearerToken = null;

export function setApiIdentity({ userId = null, token = null } = {}) {
  currentUserId = userId;
  bearerToken = token;
}

export function getApiUserId() {
  return currentUserId;
}

function authHeaders() {
  const headers = {};
  if (currentUserId) headers['x-user-id'] = currentUserId;
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  return headers;
}

export class ApiRequestError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const THAI = /[\u0E00-\u0E7F]/;

/**
 * Turn an error body into a message in the reader's language. The server
 * sends a stable `code`; a known code wins, then the server's own text —
 * unless that text is in a script the reader did not choose (the backend has
 * historically answered in Thai), in which case a generic line naming the
 * code is more useful than an unreadable one.
 */
export function localizeError(data, status) {
  const code = data?.code;
  // t() returns the key itself for a string no dictionary defines.
  const known = code ? t(`apiError.${code}`) : null;
  if (known && known !== `apiError.${code}`) return known;
  if (status === 429) return t('apiError.RATE_LIMITED');
  const message = data?.error;
  const readerLocale = (typeof document !== 'undefined' && document.documentElement.lang) || 'en';
  if (message && !(!readerLocale.startsWith('th') && THAI.test(message))) return message;
  return t('apiError.generic', { code: code ?? `HTTP ${status}` });
}

/**
 * api('/api/servers/1')                         GET
 * api('/api/servers', { method: 'POST', body })  JSON body
 * api('/api/upload/avatar', { method: 'POST', body: formData })  multipart
 */
export async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    signal,
    headers: {
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...headers
    },
    body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body))
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) {
    throw new ApiRequestError(localizeError(data, res.status), {
      status: res.status, code: data?.code, details: data?.details
    });
  }
  return data;
}

export const get  = (path, opts) => api(path, { ...opts, method: 'GET' });
export const post = (path, body, opts) => api(path, { ...opts, method: 'POST', body });
export const put  = (path, body, opts) => api(path, { ...opts, method: 'PUT', body });
export const patch = (path, body, opts) => api(path, { ...opts, method: 'PATCH', body });
export const del  = (path, opts) => api(path, { ...opts, method: 'DELETE' });

/** Upload one file under the field name the route expects. */
export async function upload(path, fieldName, file, extra = {}) {
  const form = new FormData();
  form.append(fieldName, file);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return api(path, { method: 'POST', body: form });
}
