// Small HTTP helpers shared by the route modules.

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
        return next(new ApiError('เซสชันหมดอายุหรือไม่ถูกต้อง', {
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

/** Central error responder. Mount last. */
export function errorHandler(err, req, res, _next) {
  const status = err.status ?? 500;
  if (status >= 500) {
    console.error(`💥 ${req.method} ${req.originalUrl}`, err);
  }
  res.status(status).json({
    error: err.message || 'Internal server error',
    code: err.code ?? 'INTERNAL_ERROR',
    ...(err.details ? { details: err.details } : {})
  });
}

/** Parse and clamp a pagination limit. */
export function parseLimit(value, { fallback = 50, max = 100 } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}
