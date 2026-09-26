// Small HTTP helpers shared by the route modules.

import { classifyDatabaseError } from '../db/dialect.js';

export class ApiError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  static notFound(what = 'Resource') { return new ApiError(`${what} not found`, { status: 404, code: 'NOT_FOUND' }); }
  static forbidden(msg = 'Missing permissions') { return new ApiError(msg, { status: 403, code: 'FORBIDDEN' }); }
  static unauthorized(msg = 'Authentication required') { return new ApiError(msg, { status: 401, code: 'UNAUTHENTICATED' }); }
  static conflict(msg) { return new ApiError(msg, { status: 409, code: 'CONFLICT' }); }
}

/**
 * Wrap an async handler so a rejected promise reaches the error middleware
 * instead of hanging the request. Express 4 does not do this for you.
 */
export const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Resolve the acting user.
 *
 * Order: a real session (Bearer token or HttpOnly cookie) first; then, only when
 * ALLOW_DEV_IDENTITY is enabled, the `x-user-id` header. The dev path exists so
 * the multi-account switcher and the test suite can act as a seed user without
 * a login round-trip, and it is refused outright in production.
 */
export function makeIdentify({ resolveSession, allowDevIdentity }) {
  return async function identify(req, _res, next) {
    try {
      const { extractToken } = await import('./auth.js');

      // `Authorization: Bot <token>` identifies an application's bot user.
      // From here on the request is indistinguishable from that user acting
      // for themselves, which is the point: one permission gate, not two.
      const authorization = req.get('authorization');
      if (authorization?.startsWith('Bot ')) {
        const { resolveBotToken } = await import('../services/applications.js');
        const bot = await resolveBotToken(authorization.slice(4).trim());
        if (!bot) {
          return next(new ApiError('Invalid bot token', { status: 401, code: 'INVALID_BOT_TOKEN' }));
        }
        req.userId = bot.userId;
        req.botApplicationId = bot.applicationId;
        return next();
      }

      const token = extractToken(req);
      if (token) {
        const session = await resolveSession(token);
        if (session) {
          req.userId = session.userId;
          req.sessionId = session.sessionId;
          return next();
        }
        // A presented token that does not resolve is expired, revoked or forged.
        // Rejecting outright is the honest answer: silently falling back to
        // another identity would let a stale token appear to still work.
        return next(new ApiError('Your session has expired or is invalid', {
          status: 401, code: 'INVALID_SESSION'
        }));
      }

      if (allowDevIdentity) {
        req.userId = req.get('x-user-id') || req.body?.userId || req.query?.userId || null;
      } else {
        req.userId = null;
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** @deprecated dev-only fallback kept for scripts that import it directly. */
export function identify(req, _res, next) {
  req.userId = req.get('x-user-id') || req.body?.userId || req.query?.userId || null;
  next();
}

export function requireUser(req, _res, next) {
  if (!req.userId) return next(ApiError.unauthorized());
  next();
}

/**
 * What a client may be told about an error: ApiErrors (and other errors that
 * carry an explicit HTTP status) as they are; database errors mapped to a
 * status and a stable code; anything else a generic 500. Raw database or
 * library text never reaches a client — it names tables and constraints.
 */
export function publicError(err) {
  if (err instanceof ApiError || (Number.isInteger(err?.status) && err.status < 500 && !err.isDatabaseError)) {
    return {
      status: err.status ?? 400,
      body: {
        error: err.message || 'Bad request',
        code: err.code ?? 'BAD_REQUEST',
        ...(err.details ? { details: err.details } : {})
      }
    };
  }
  const db = classifyDatabaseError(err);
  if (db) return { status: db.status, body: { error: db.message, code: db.code } };
  return { status: 500, body: { error: 'Internal server error', code: 'INTERNAL_ERROR' } };
}

/** Central error responder. Mount last. */
export function errorHandler(err, req, res, _next) {
  const { status, body } = publicError(err);
  if (status >= 500 || err?.isDatabaseError) {
    // Constant format string; the URL is client-controlled, so strip control
    // characters before it reaches the log (no forged log lines).
    const url = String(req.originalUrl ?? '').replace(/[\u0000-\u001f\u007f]/g, '?');
    console.error('💥 %s %s [%s]', req.method, url, req.requestId ?? '-', err);
  }
  // A server error says nothing about its cause, only how to find it in the
  // logs: the same id is in the X-Request-Id header and the log line above.
  if (status >= 500 && req.requestId) body.request_id = req.requestId;
  res.status(status).json(body);
}

/** Parse and clamp a pagination limit. */
export function parseLimit(value, { fallback = 50, max = 100 } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}
