// ============================================================================
//  Web Push (RFC 8030 + VAPID RFC 8292, payload encryption RFC 8291 via the
//  `web-push` library).
//
//  Off unless VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are all
//  set (`npm run push:keys` prints a fresh pair). When off, every entry point
//  is a no-op and the HTTP API reports { enabled: false }.
//
//  Delivery rules:
//    - one subscription per browser endpoint, owned by the session (device
//      login) that registered it; ending that session deletes it;
//    - no push to a user who has a focused client right now (the client
//      reports focus over the socket) — that client notifies in-page;
//    - payload is Declarative Web Push JSON (Safari 18.4+ shows it without
//      running the service worker); other browsers hand the same JSON to
//      public/sw.js, which shows it;
//    - Topic = channel, so a push service replaces an undelivered older push
//      for the same channel; the notification tag does the same on screen;
//    - 404/410 from the push service = subscription gone, deleted;
//    - per-user token bucket, so a busy channel cannot become a push storm.
// ============================================================================

import https from 'node:https';
import fs from 'node:fs';
import webpush from 'web-push';
import { runQuery, getQuery, allQuery } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { consume } from '../lib/rateLimit.js';
import { sessionEvents } from '../lib/sessionEvents.js';

const env = process.env;
const DEFAULT_HOSTS = [
  'fcm.googleapis.com', 'android.googleapis.com',            // Chrome, Edge (Android), Opera
  'updates.push.services.mozilla.com', 'push.services.mozilla.com', // Firefox
  'web.push.apple.com', 'push.apple.com',                     // Safari
  'notify.windows.com'                                        // Edge (Windows / WNS)
];
const MAX_SUBSCRIPTIONS_PER_USER = 10;
const MAX_FAILURES = 5;
const FOCUS_TTL_MS = 3 * 60_000;
const SEND_CONCURRENCY = 16;

// --- configuration -----------------------------------------------------------

function readConfig() {
  const publicKey = String(env.VAPID_PUBLIC_KEY ?? '').trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY ?? '').trim();
  const subject = String(env.VAPID_SUBJECT ?? '').trim();
  const hosts = String(env.PUSH_ENDPOINT_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const cfg = {
    enabled: false,
    publicKey, privateKey, subject,
    hosts: hosts.length ? hosts : DEFAULT_HOSTS,
    allowInsecureHosts: env.NODE_ENV !== 'production' && env.PUSH_ALLOW_INSECURE_ENDPOINTS === '1',
    userLimitPerMinute: Number(env.PUSH_USER_LIMIT_PER_MIN) || 30,
    ttlSeconds: Number(env.PUSH_TTL_SECONDS) || 4 * 60 * 60,
    agent: null,
    error: null
  };
  if (!publicKey && !privateKey && !subject) return cfg;
  try {
    if (!/^(mailto:|https:\/\/)/.test(subject)) throw new Error('VAPID_SUBJECT must be a mailto: or https:// URL');
    webpush.setVapidDetails(subject, publicKey, privateKey);   // validates key lengths
    cfg.enabled = true;
  } catch (err) {
    cfg.error = err.message;
    console.warn(`⚠️  Web Push disabled: ${err.message}`);
  }
  // An extra CA for push endpoints — for a private push relay or the test
  // suite's local push service. It adds trust; it never removes any.
  if (env.PUSH_EXTRA_CA_FILE) {
    try {
      cfg.agent = new https.Agent({ ca: [fs.readFileSync(env.PUSH_EXTRA_CA_FILE)], keepAlive: true });
    } catch (err) { console.warn(`⚠️  PUSH_EXTRA_CA_FILE unreadable: ${err.message}`); }
  }
  return cfg;
}

const config = readConfig();

export const isEnabled = () => config.enabled;

/** For /api/health and the client: never includes the private key. */
export function status() {
  return {
    enabled: config.enabled,
    public_key: config.enabled ? config.publicKey : null,
    ...(config.error ? { error: config.error } : {})
  };
}

// --- focus tracking ----------------------------------------------------------

const socketState = new Map();   // socketId -> { userId, focused, at }
const socketsOf = new Map();     // userId -> Set<socketId>

export function setClientState(socketId, userId, { focused }) {
  if (!socketId || !userId) return;
  socketState.set(socketId, { userId, focused: Boolean(focused), at: Date.now() });
  if (!socketsOf.has(userId)) socketsOf.set(userId, new Set());
  socketsOf.get(userId).add(socketId);
}

export function forgetSocket(socketId) {
  const state = socketState.get(socketId);
  if (!state) return;
  socketState.delete(socketId);
  const set = socketsOf.get(state.userId);
  set?.delete(socketId);
  if (set && set.size === 0) socketsOf.delete(state.userId);
}

/** Does the user have a client in front of them right now? */
export function hasFocusedClient(userId, now = Date.now()) {
  for (const sid of socketsOf.get(userId) ?? []) {
    const s = socketState.get(sid);
    if (s?.focused && now - s.at < FOCUS_TTL_MS) return true;
  }
  return false;
}

/** Wire the socket side: clients report `client_state` { focused }. */
export function attachGateway(io) {
  io.on('connection', (socket) => {
    socket.on('client_state', (state = {}) => {
      const userId = socket.data?.userId;
      if (!userId || typeof state !== 'object') return;
      // Cheap, but still bounded: a misbehaving tab cannot spin the map.
      if (!consume(`client_state:${socket.id}`, { limit: 30, windowMs: 60_000 }).allowed) return;
      setClientState(socket.id, userId, { focused: state.focused === true });
    });
    socket.on('disconnect', () => forgetSocket(socket.id));
  });
}

// --- subscriptions -----------------------------------------------------------

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function hostAllowed(hostname) {
  const host = hostname.toLowerCase();
  return config.hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Validate a browser PushSubscription.toJSON(). Throws ApiError. */
export function validateSubscription(sub) {
  const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint.trim() : '';
  if (!endpoint || endpoint.length > 1024) throw new ApiError('A push endpoint is required', { code: 'INVALID_SUBSCRIPTION' });
  let url;
  try { url = new URL(endpoint); } catch { throw new ApiError('The push endpoint is not a URL', { code: 'INVALID_SUBSCRIPTION' }); }
  // The server POSTs to this URL, so it must be a real push service: https,
  // no credentials, and a known push host — never an arbitrary (internal) URL.
  const insecureOk = config.allowInsecureHosts && url.protocol === 'http:';
  if ((url.protocol !== 'https:' && !insecureOk) || url.username || url.password || !hostAllowed(url.hostname)) {
    throw new ApiError('That push service is not allowed', { code: 'PUSH_ENDPOINT_NOT_ALLOWED' });
  }
  const p256dh = String(sub?.keys?.p256dh ?? '');
  const auth = String(sub?.keys?.auth ?? '');
  // p256dh: uncompressed P-256 point (65 bytes → 87 chars); auth: 16 bytes.
  if (!B64URL.test(p256dh) || p256dh.length < 80 || p256dh.length > 100
      || !B64URL.test(auth) || auth.length < 16 || auth.length > 32) {
    throw new ApiError('The subscription keys are invalid', { code: 'INVALID_SUBSCRIPTION' });
  }
  let expirationTime = null;
  if (sub.expirationTime !== undefined && sub.expirationTime !== null) {
    const at = new Date(Number(sub.expirationTime));
    if (Number.isNaN(at.getTime())) throw new ApiError('expirationTime is invalid', { code: 'INVALID_SUBSCRIPTION' });
    expirationTime = at.toISOString();
  }
  return { endpoint: url.toString(), p256dh, auth, expirationTime };
}

export async function subscribe({ userId, sessionId = null, subscription, userAgent = null }) {
  if (!config.enabled) throw new ApiError('Push notifications are not configured on this server', { status: 404, code: 'PUSH_DISABLED' });
  const clean = validateSubscription(subscription);
  // The same browser re-subscribing (or a different account signing in on
  // it) takes the endpoint over: one endpoint, one owner.
  await runQuery(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [clean.endpoint]);
  const id = generateId();
  await runQuery(
    `INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, user_agent, expiration_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, sessionId, clean.endpoint, clean.p256dh, clean.auth,
     userAgent ? String(userAgent).slice(0, 300) : null, clean.expirationTime]
  );
  // Bound the per-user list: the oldest device registration goes first.
  const extra = await allQuery(
    `SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET ?`,
    [userId, MAX_SUBSCRIPTIONS_PER_USER]
  );
  for (const row of extra) await runQuery(`DELETE FROM push_subscriptions WHERE id = ?`, [row.id]);
  return { id, endpoint: clean.endpoint };
}

export async function unsubscribe({ userId, endpoint }) {
  const result = await runQuery(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`, [userId, String(endpoint ?? '')]
  );
  return { removed: result.changes ?? 0 };
}

export async function listSubscriptions(userId, currentSessionId = null) {
  const rows = await allQuery(
    `SELECT id, session_id, endpoint, user_agent, created_at, last_success_at
       FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
  // The endpoint is a bearer capability for the push service; show only its host.
  return rows.map((r) => ({
    id: r.id,
    host: (() => { try { return new URL(r.endpoint).hostname; } catch { return null; } })(),
    user_agent: r.user_agent,
    created_at: r.created_at,
    last_success_at: r.last_success_at,
    current_session: Boolean(currentSessionId && r.session_id === currentSessionId)
  }));
}

export async function removeSubscriptionById(userId, id) {
  const result = await runQuery(`DELETE FROM push_subscriptions WHERE user_id = ? AND id = ?`, [userId, id]);
  return { removed: result.changes ?? 0 };
}

/** Sessions ended (logout, revoke, "log out everywhere"): drop their devices. */
export async function removeForSessions({ sessionIds = null, userId = null, exceptSessionId = null }) {
  if (sessionIds?.length) {
    await runQuery(
      `DELETE FROM push_subscriptions WHERE session_id IN (${sessionIds.map(() => '?').join(',')})`,
      sessionIds
    );
  } else if (userId && exceptSessionId) {
    await runQuery(
      `DELETE FROM push_subscriptions WHERE user_id = ? AND (session_id IS NULL OR session_id <> ?)`,
      [userId, exceptSessionId]
    );
  } else if (userId) {
    await runQuery(`DELETE FROM push_subscriptions WHERE user_id = ?`, [userId]);
  }
}

let listening = false;
export function listenForSessionEnd() {
  if (listening) return;
  listening = true;
  sessionEvents.on('revoked', (payload) => {
    removeForSessions(payload ?? {}).catch((err) => console.warn('push cleanup failed:', err.message));
  });
}

// --- payloads ----------------------------------------------------------------

const APP_NAME = () => env.PUSH_APP_NAME || 'Antigravity';

/** Turn raw mention/emoji tokens into readable text. */
export function readablePreview(text, names = {}) {
  return String(text ?? '')
    .replace(/<@!?([\w-]+)>/g, (_, id) => `@${names.users?.[id] ?? 'user'}`)
    .replace(/<@&([\w-]+)>/g, (_, id) => `@${names.roles?.[id] ?? 'role'}`)
    .replace(/<#([\w-]+)>/g, (_, id) => `#${names.channels?.[id] ?? 'channel'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\|\|[\s\S]*?\|\|/g, '▒▒▒')   // spoilers stay hidden on a lock screen
    .trim();
}

/**
 * The push body, as Declarative Web Push JSON. `notification.navigate` must be
 * absolute. `data` is ignored by declarative handling and read by public/sw.js.
 */
export function buildPayload({
  kind, authorName, serverName = null, channelName = null, isDm, text, pushContent = 'full',
  url, badge = 0, channelId, serverId = null, messageId = null
}) {
  let title;
  let body;
  if (pushContent === 'hidden') {
    title = APP_NAME();
    body = 'You have a new notification';
  } else {
    const where = isDm ? null : [channelName ? `#${channelName}` : null, serverName].filter(Boolean).join(', ');
    title = where ? `${authorName} (${where})` : authorName;
    if (pushContent === 'name_only') {
      body = kind === 'mention' ? 'Mentioned you' : kind === 'keyword' ? 'Mentioned a keyword' : 'Sent a message';
    } else {
      body = text || 'Sent an attachment';
    }
  }
  const count = Math.max(0, Math.floor(Number(badge) || 0));
  return {
    web_push: 8030,
    notification: {
      title: title.slice(0, 120),
      body: body.slice(0, 240),
      navigate: url,
      tag: `channel-${channelId}`,
      silent: false,
      dir: 'auto',
      ...(count > 0 ? { app_badge: String(count) } : {})
    },
    data: { kind, channel_id: channelId, server_id: serverId, message_id: messageId, url, badge: count }
  };
}

function appUrl(path) {
  const base = String(env.PUBLIC_URL || `http://localhost:${env.PORT || 3001}`).replace(/\/+$/, '');
  return `${base}${path}`;
}

// --- sending -----------------------------------------------------------------

/** Push topic: ≤ 32 URL-safe characters (RFC 8030 §5.4). */
const topicFor = (channelId) => `c${String(channelId).replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 32);

async function inChunks(ids, fn, size = 500) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size))));
  return out;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

let sendImpl = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options);
/** Test seam: replace the transport (returns the previous one). */
export function __setTransport(fn) { const prev = sendImpl; sendImpl = fn; return prev; }

/** Deliver one payload to one subscription row; prunes dead subscriptions. */
async function deliver(row, payload, { urgency = 'normal', topic }) {
  try {
    await sendImpl(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload),
      {
        TTL: config.ttlSeconds,
        urgency,
        topic,
        contentEncoding: 'aes128gcm',
        vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
        ...(config.agent ? { agent: config.agent } : {}),
        timeout: 10_000
      }
    );
    if (Number(row.failure_count) > 0 || !row.last_success_at) {
      await runQuery(
        `UPDATE push_subscriptions SET failure_count = 0, last_success_at = ? WHERE id = ?`,
        [new Date().toISOString(), row.id]
      );
    }
    return 'sent';
  } catch (err) {
    const code = err?.statusCode;
    if (code === 404 || code === 410) {
      await runQuery(`DELETE FROM push_subscriptions WHERE id = ?`, [row.id]);
      return 'gone';
    }
    // 413 (payload too big) and 400 are our bug, 429/5xx the service's
    // weather; count failures and give up on a subscription that never works.
    const failures = Number(row.failure_count ?? 0) + 1;
    if (failures >= MAX_FAILURES) await runQuery(`DELETE FROM push_subscriptions WHERE id = ?`, [row.id]);
    else await runQuery(`UPDATE push_subscriptions SET failure_count = ? WHERE id = ?`, [failures, row.id]);
    console.warn(`push to ${(() => { try { return new URL(row.endpoint).hostname; } catch { return '?'; } })()} failed: ${code ?? err?.message}`);
    return 'failed';
  }
}

/**
 * Push one message to everyone services/notifications.js decided to notify.
 * `recipients`: [{ uid, kind }] with kind mention | keyword | dm | message.
 */
export async function sendMessagePush({ recipients, channel, serverId, messageId, authorId, preview }) {
  if (!config.enabled || !recipients?.length) return { sent: 0 };
  const targets = recipients.filter((r) => !hasFocusedClient(r.uid));
  if (!targets.length) return { sent: 0 };

  const ids = targets.map((r) => r.uid);
  const subs = await inChunks(ids, (chunk) => allQuery(
    `SELECT id, user_id, endpoint, p256dh, auth, failure_count, last_success_at
       FROM push_subscriptions WHERE user_id IN (${chunk.map(() => '?').join(',')})`,
    chunk
  ));
  if (!subs.length) return { sent: 0 };
  const withSubs = [...new Set(subs.map((s) => s.user_id))];

  const [prefs, badges, author, server] = await Promise.all([
    inChunks(withSubs, (chunk) => allQuery(
      `SELECT user_id, push_content FROM notification_prefs WHERE user_id IN (${chunk.map(() => '?').join(',')})`, chunk
    )),
    inChunks(withSubs, (chunk) => allQuery(
      `SELECT user_id, SUM(mention_count) AS total FROM read_states
        WHERE user_id IN (${chunk.map(() => '?').join(',')}) GROUP BY user_id`, chunk
    )),
    authorId ? getQuery(`SELECT display_name, username FROM users WHERE id = ?`, [authorId]) : null,
    serverId ? getQuery(`SELECT name FROM servers WHERE id = ?`, [serverId]) : null
  ]);
  const contentOf = new Map(prefs.map((p) => [p.user_id, p.push_content]));
  const badgeOf = new Map(badges.map((b) => [b.user_id, Number(b.total) || 0]));
  const kindOf = new Map(targets.map((r) => [r.uid, r.kind]));

  // Resolve names for mention tokens once for the whole fan-out.
  const names = { users: {}, roles: {}, channels: {} };
  const userIds = [...preview.matchAll(/<@!?([\w-]+)>/g)].map((m) => m[1]).slice(0, 20);
  const roleIds = [...preview.matchAll(/<@&([\w-]+)>/g)].map((m) => m[1]).slice(0, 20);
  const chanIds = [...preview.matchAll(/<#([\w-]+)>/g)].map((m) => m[1]).slice(0, 20);
  const ph = (xs) => xs.map(() => '?').join(',');
  if (userIds.length) for (const u of await allQuery(`SELECT id, display_name FROM users WHERE id IN (${ph(userIds)})`, userIds)) names.users[u.id] = u.display_name;
  if (roleIds.length && serverId) for (const r of await allQuery(`SELECT id, name FROM roles WHERE server_id = ? AND id IN (${ph(roleIds)})`, [serverId, ...roleIds])) names.roles[r.id] = r.name;
  if (chanIds.length && serverId) for (const c of await allQuery(`SELECT id, name FROM channels WHERE server_id = ? AND id IN (${ph(chanIds)})`, [serverId, ...chanIds])) names.channels[c.id] = c.name;
  const text = readablePreview(preview, names);

  const isDm = !serverId;
  const url = appUrl(`/channels/${serverId ?? '@me'}/${channel.id}${messageId ? `/${messageId}` : ''}`);
  const topic = topicFor(channel.id);
  const authorName = author?.display_name || author?.username || 'Someone';

  const jobs = [];
  const allowedUsers = new Set();
  for (const uid of withSubs) {
    // A busy channel at "all messages" must not become a push storm; the
    // topic already collapses anything the device has not received yet.
    if (!consume(`push-user:${uid}`, { limit: config.userLimitPerMinute, windowMs: 60_000 }).allowed) continue;
    allowedUsers.add(uid);
  }
  for (const row of subs) {
    if (!allowedUsers.has(row.user_id)) continue;
    const kind = kindOf.get(row.user_id);
    const payload = buildPayload({
      kind, authorName, serverName: server?.name ?? null, channelName: channel.name ?? null, isDm, text,
      pushContent: contentOf.get(row.user_id) ?? 'full', url, badge: badgeOf.get(row.user_id) ?? 0,
      channelId: channel.id, serverId, messageId
    });
    jobs.push({ row, payload, urgency: kind === 'message' ? 'normal' : 'high' });
  }
  let sent = 0;
  await mapLimit(jobs, SEND_CONCURRENCY, async (job) => {
    if ((await deliver(job.row, job.payload, { urgency: job.urgency, topic })) === 'sent') sent += 1;
  });
  return { sent, attempted: jobs.length };
}

/** "Send me a test notification" from settings. */
export async function sendTestPush(userId) {
  if (!config.enabled) throw new ApiError('Push notifications are not configured on this server', { status: 404, code: 'PUSH_DISABLED' });
  const subs = await allQuery(
    `SELECT id, user_id, endpoint, p256dh, auth, failure_count, last_success_at FROM push_subscriptions WHERE user_id = ?`,
    [userId]
  );
  const payload = {
    web_push: 8030,
    notification: {
      title: APP_NAME(), body: 'Push notifications are working.', navigate: appUrl('/channels/@me'),
      tag: 'push-test', silent: false
    },
    data: { kind: 'test', url: appUrl('/channels/@me') }
  };
  const results = [];
  for (const row of subs) results.push(await deliver(row, payload, { urgency: 'normal', topic: 'test' }));
  return { attempted: subs.length, sent: results.filter((r) => r === 'sent').length, removed: results.filter((r) => r === 'gone').length };
}

/** Periodic maintenance: drop subscriptions past their expirationTime. */
export async function pruneExpired(now = new Date()) {
  const result = await runQuery(
    `DELETE FROM push_subscriptions WHERE expiration_time IS NOT NULL AND expiration_time < ?`,
    [now.toISOString()]
  );
  return result.changes ?? 0;
}
