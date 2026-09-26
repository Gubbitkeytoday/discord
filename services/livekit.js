// ============================================================================
//  LiveKit SFU (optional) — tokens, grants, moderation and webhook sync.
//
//  Voice has two media paths:
//    * mesh    — the original peer-to-peer WebRTC mesh, signalled over the
//                Socket.IO gateway. Always available; capped at VOICE_MESH_LIMIT.
//    * livekit — a LiveKit SFU. Used when LIVEKIT_URL, LIVEKIT_API_KEY and
//                LIVEKIT_API_SECRET are all set. Each voice channel is a LiveKit
//                room named after the channel id; each participant's identity is
//                the user id.
//
//  In both modes the gateway stays the source of truth for the roster
//  (voice_states): who is in which channel, mute/deafen flags, stage speakers,
//  speaking indicators, the soundboard. LiveKit only carries the media. The
//  webhook below keeps voice_states honest when a participant reaches or leaves
//  the SFU without the gateway noticing (a crashed tab, a lost socket).
//
//  Permissions are enforced by LiveKit itself, not only by the client: the
//  token's grants come from the same Discord-style permission bits the rest of
//  the app uses, and every later change (server mute/deafen, stage promotion)
//  is pushed to the SFU through the RoomService API, which revokes publishing
//  or subscribing on the spot.
// ============================================================================

import crypto from 'node:crypto';
import {
  AccessToken, RoomServiceClient, WebhookReceiver, TrackSource
} from 'livekit-server-sdk';

import { getQuery } from '../db.js';
import { ApiError } from '../lib/httpUtils.js';
import { has } from '../lib/permissions.js';
import { assertChannelAccess } from './access.js';

const VOICE_TYPES = new Set(['voice', 'stage', 'dm', 'group_dm']);

// --- configuration ----------------------------------------------------------

/**
 * Read the LiveKit settings from an env-like object. Pure, so tests can call it
 * with any object. `enabled` is false unless the three required values are set
 * and the URLs parse — a half-configured SFU must fall back to the mesh rather
 * than hand clients a token for a server that does not exist.
 */
export function readLivekitConfig(env = process.env) {
  const url = String(env.LIVEKIT_URL ?? '').trim();
  const apiKey = String(env.LIVEKIT_API_KEY ?? '').trim();
  const apiSecret = String(env.LIVEKIT_API_SECRET ?? '').trim();
  let host = String(env.LIVEKIT_HOST ?? '').trim();
  const problems = [];

  if (!url && !apiKey && !apiSecret) {
    return { enabled: false, reason: 'not_configured', problems };
  }
  if (!url) problems.push('LIVEKIT_URL is not set');
  if (!apiKey) problems.push('LIVEKIT_API_KEY is not set');
  if (!apiSecret) problems.push('LIVEKIT_API_SECRET is not set');
  if (url && !/^wss?:\/\/[^\s/]+/i.test(url)) problems.push('LIVEKIT_URL must start with ws:// or wss://');
  // LiveKit refuses secrets shorter than 32 characters at boot; so do we.
  if (apiSecret && apiSecret.length < 32) problems.push('LIVEKIT_API_SECRET must be at least 32 characters');

  // The server API normally lives on the same host as the client URL, over
  // HTTP(S). LIVEKIT_HOST overrides it (e.g. http://livekit:7880 inside Docker).
  if (!host && url) host = url.replace(/^ws/i, 'http');
  if (host && !/^https?:\/\/[^\s/]+/i.test(host)) problems.push('LIVEKIT_HOST must start with http:// or https://');

  if (problems.length) return { enabled: false, reason: 'misconfigured', problems };

  const ttlSeconds = Math.min(3600, Math.max(60, Number.parseInt(env.LIVEKIT_TOKEN_TTL_SECONDS, 10) || 600));
  const roomLimit = Math.max(0, Number.parseInt(env.LIVEKIT_ROOM_LIMIT, 10) || 0);
  const codec = String(env.LIVEKIT_VIDEO_CODEC ?? 'auto').toLowerCase();
  return {
    enabled: true,
    url,
    host: host.replace(/\/+$/, ''),
    apiKey,
    apiSecret,
    ttlSeconds,
    // 0 = only the channel's own user_limit applies.
    roomLimit,
    // Media encryption with a per-room key derived from LIVEKIT_E2EE_SECRET.
    // It hides media from the SFU operator (e.g. a hosted LiveKit), not from
    // this app's server, which derives the key. Off by default: it costs CPU
    // and disables RED.
    e2eeSecret: env.LIVEKIT_E2EE === '1' || env.LIVEKIT_E2EE === 'true'
      ? String(env.LIVEKIT_E2EE_SECRET || apiSecret)
      : null,
    videoCodec: ['auto', 'vp8', 'vp9', 'av1', 'h264'].includes(codec) ? codec : 'auto',
    problems
  };
}

let cached = null;
let cachedKey = '';

/** The active configuration, re-read if the environment changed (tests). */
export function livekitConfig() {
  const key = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_HOST',
    'LIVEKIT_TOKEN_TTL_SECONDS', 'LIVEKIT_ROOM_LIMIT', 'LIVEKIT_E2EE', 'LIVEKIT_E2EE_SECRET',
    'LIVEKIT_VIDEO_CODEC'].map((k) => process.env[k] ?? '').join('\u0000');
  if (!cached || key !== cachedKey) {
    cached = readLivekitConfig(process.env);
    cachedKey = key;
    roomService = null;
    webhookReceiver = null;
    if (!cached.enabled && cached.reason === 'misconfigured') {
      // Never the secret itself — only which variable is wrong.
      console.warn(`LiveKit disabled, falling back to mesh: ${cached.problems.join('; ')}`);
    }
  }
  return cached;
}

export const isLivekitEnabled = () => livekitConfig().enabled;

let roomService = null;
let webhookReceiver = null;

function rooms() {
  const cfg = livekitConfig();
  if (!cfg.enabled) return null;
  roomService ??= new RoomServiceClient(cfg.host, cfg.apiKey, cfg.apiSecret);
  return roomService;
}

function receiver() {
  const cfg = livekitConfig();
  if (!cfg.enabled) return null;
  webhookReceiver ??= new WebhookReceiver(cfg.apiKey, cfg.apiSecret);
  return webhookReceiver;
}

// --- ICE servers (mesh mode) -----------------------------------------------

const list = (value) => String(value ?? '').split(',').map((v) => v.trim()).filter(Boolean);

/**
 * STUN/TURN for the mesh. Same scheme as GET /api/voice/ice-servers: TURN REST
 * credentials (coturn use-auth-secret), short-lived and per user.
 */
export function buildIceServers(userId, env = process.env) {
  const stun = list(env.STUN_URLS ?? 'stun:stun.l.google.com:19302');
  const iceServers = stun.length ? [{ urls: stun }] : [];
  const turn = list(env.TURN_URLS);
  if (turn.length && env.TURN_SECRET) {
    const ttl = Math.max(60, Number.parseInt(env.TURN_TTL_SECONDS, 10) || 86400);
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${userId}`;
    const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls: turn, username, credential });
  }
  return { iceServers, iceTransportPolicy: env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all' };
}

/** What GET /api/voice/config tells a client. Never contains a secret. */
export function clientVoiceConfig(userId) {
  const cfg = livekitConfig();
  const meshLimit = Number(process.env.VOICE_MESH_LIMIT) || 8;
  return {
    mode: cfg.enabled ? 'livekit' : 'mesh',
    livekit: cfg.enabled
      ? { url: cfg.url, e2ee: Boolean(cfg.e2eeSecret), videoCodec: cfg.videoCodec }
      : null,
    meshLimit,
    ...buildIceServers(userId)
  };
}

// --- grants -------------------------------------------------------------------

/**
 * Derive what a user may do in a voice channel's LiveKit room.
 *
 *   CONNECT         → may join at all (checked before this is called)
 *   SPEAK           → microphone
 *   STREAM          → camera, screen share and its audio ("Video" in Discord)
 *   stage channels  → only speakers (not suppressed) and stage moderators
 *                     (MUTE_MEMBERS) publish; the audience subscribes only
 *   server mute     → no microphone, whatever the roles say
 *   server deafen   → no subscribing, and (as on Discord) no microphone
 *
 * `state` is the user's voice_states row for this channel (may be null when the
 * gateway has not seen the join yet) and `member` their server_members row.
 */
export function computeGrants({ channel, permissions, isDm, state = null, member = null }) {
  const can = (flag) => isDm || has(permissions, flag);
  const serverMute = Boolean(state?.server_mute) || Boolean(member?.is_mute);
  const serverDeaf = Boolean(state?.server_deaf) || Boolean(member?.is_deaf);
  const isStage = channel.type === 'stage';
  const stageModerator = isStage && can('MUTE_MEMBERS');
  // A stage speaker is someone the gateway has un-suppressed; without a row
  // (not joined through the gateway yet) only moderators start as speakers.
  const stageSpeaker = isStage && (stageModerator || (state ? !state.suppress : false));

  const mayPublish = !isStage || stageSpeaker;
  const sources = [];
  if (mayPublish && can('SPEAK') && !serverMute && !serverDeaf) sources.push(TrackSource.MICROPHONE);
  if (mayPublish && can('STREAM')) {
    sources.push(TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  }
  return {
    canPublish: sources.length > 0,
    canPublishSources: sources,
    canSubscribe: !serverDeaf,
    // Data messages are not used (the gateway carries everything); keeping
    // them off stops a client from spraying unauthenticated payloads at peers.
    canPublishData: false,
    canUpdateOwnMetadata: false,
    // Summary for the client UI and tests.
    summary: {
      audio: sources.includes(TrackSource.MICROPHONE),
      video: sources.includes(TrackSource.CAMERA),
      screen: sources.includes(TrackSource.SCREEN_SHARE),
      subscribe: !serverDeaf,
      stageRole: isStage ? (stageSpeaker ? (stageModerator ? 'moderator' : 'speaker') : 'audience') : null,
      serverMute,
      serverDeaf
    }
  };
}

/** Load everything computeGrants needs for (channel, user). Throws 403/404. */
async function resolveGrants({ channelId, userId }) {
  const { channel, permissions, isDm } = await assertChannelAccess({ channelId, userId, permission: 'CONNECT' });
  if (!VOICE_TYPES.has(channel.type)) {
    throw new ApiError('Not a voice channel', { status: 400, code: 'NOT_VOICE_CHANNEL' });
  }
  const state = await getQuery(
    `SELECT channel_id, server_mute, server_deaf, suppress FROM voice_states WHERE user_id = ? AND channel_id = ?`,
    [userId, channelId]
  );
  const member = channel.server_id
    ? await getQuery(`SELECT is_mute, is_deaf FROM server_members WHERE server_id = ? AND user_id = ?`, [channel.server_id, userId])
    : null;
  return { channel, grants: computeGrants({ channel, permissions, isDm, state, member }) };
}

/** Deterministic per-room media key (only when E2EE is on). */
function e2eeKeyFor(cfg, channelId) {
  return crypto.createHmac('sha256', cfg.e2eeSecret).update(`livekit-e2ee:${channelId}`).digest('base64url');
}

/**
 * Mint a short-lived room token for `userId` in voice channel `channelId`.
 * Throws 503 LIVEKIT_DISABLED when the SFU is not configured, 403 without
 * CONNECT, 404 for an unknown channel.
 */
export async function issueToken({ channelId, userId }) {
  const cfg = livekitConfig();
  if (!cfg.enabled) {
    throw new ApiError('LiveKit is not configured on this server', { status: 503, code: 'LIVEKIT_DISABLED' });
  }
  if (typeof channelId !== 'string' || !channelId || channelId.length > 64) {
    throw new ApiError('channelId is required', { status: 400, code: 'VALIDATION' });
  }
  const { channel, grants } = await resolveGrants({ channelId, userId });

  // Same capacity rule as the gateway's join_voice, so a client cannot skip
  // the gateway and overfill a room straight on the SFU.
  const limits = await getQuery(`SELECT user_limit FROM channels WHERE id = ?`, [channel.id]);
  const caps = [Number(limits?.user_limit) || 0, cfg.roomLimit].filter((n) => n > 0);
  if (caps.length) {
    const inRoom = await getQuery(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me FROM voice_states WHERE channel_id = ?`,
      [userId, channel.id]
    );
    if (!Number(inRoom?.me) && Number(inRoom?.n) >= Math.min(...caps)) {
      throw new ApiError(`This voice channel is full (${Math.min(...caps)} max)`, { status: 403, code: 'VOICE_FULL' });
    }
  }

  const user = await getQuery(`SELECT username, display_name FROM users WHERE id = ?`, [userId]);
  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
    identity: userId,
    name: user?.display_name || user?.username || userId,
    ttl: cfg.ttlSeconds
  });
  at.addGrant({
    roomJoin: true,
    room: channel.id,
    canPublish: grants.canPublish,
    canPublishSources: grants.canPublishSources,
    canSubscribe: grants.canSubscribe,
    canPublishData: grants.canPublishData,
    canUpdateOwnMetadata: grants.canUpdateOwnMetadata
  });
  const token = await at.toJwt();
  return {
    token,
    url: cfg.url,
    room: channel.id,
    identity: userId,
    expiresAt: new Date(Date.now() + cfg.ttlSeconds * 1000).toISOString(),
    grants: grants.summary,
    e2ee: cfg.e2eeSecret ? { key: e2eeKeyFor(cfg, channel.id) } : null
  };
}

// --- RoomService (best effort) ---------------------------------------------------
//
// These run after the database already changed. A LiveKit outage must not make
// a moderator action fail — the roster is still right, the client still obeys
// it — so errors are logged, and "participant not found" (not connected to the
// SFU right now) is simply normal.

const notFound = (err) => err?.status === 404 || /not.?found|does not exist/i.test(err?.message ?? '');

async function bestEffort(label, fn) {
  const svc = rooms();
  if (!svc) return false;
  try {
    await fn(svc);
    return true;
  } catch (err) {
    if (!notFound(err)) console.warn(`livekit ${label} failed: ${err.message}`);
    return false;
  }
}

/**
 * Re-derive a connected participant's grants and push them to the SFU. Called
 * after anything that changes them: server mute/deafen, stage promotion or
 * demotion. LiveKit unpublishes tracks the new permission no longer allows.
 */
export async function syncParticipantGrants(channelId, userId) {
  if (!isLivekitEnabled() || !channelId || !userId) return false;
  let grants;
  try {
    ({ grants } = await resolveGrants({ channelId, userId }));
  } catch {
    // Lost CONNECT (or the channel is gone): they must not stay in the room.
    return removeParticipant(channelId, userId);
  }
  return bestEffort('updateParticipant', (svc) => svc.updateParticipant(channelId, userId, {
    permission: {
      canPublish: grants.canPublish,
      canPublishSources: grants.canPublishSources,
      canSubscribe: grants.canSubscribe,
      canPublishData: grants.canPublishData,
      canUpdateMetadata: false
    }
  }));
}

/** Drop a participant from a room. `revoke` also invalidates their current token. */
export async function removeParticipant(channelId, userId, { revoke = false } = {}) {
  if (!isLivekitEnabled() || !channelId || !userId) return false;
  return bestEffort('removeParticipant', (svc) => svc.removeParticipant(
    channelId, userId,
    revoke ? { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) } : undefined
  ));
}

// --- webhook -----------------------------------------------------------------

const seenEvents = new Map();   // event id -> received at (dedupe re-deliveries)
const SEEN_TTL_MS = 10 * 60_000;

/**
 * Verify and decode a webhook delivery. `rawBody` must be the exact bytes
 * LiveKit sent — the signature covers their SHA-256. Returns null for a
 * re-delivered event id. Throws 401 on any verification failure.
 */
export async function receiveWebhook(rawBody, authHeader) {
  const rx = receiver();
  if (!rx) throw new ApiError('LiveKit is not configured on this server', { status: 503, code: 'LIVEKIT_DISABLED' });
  const header = String(authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
  let event;
  try {
    event = await rx.receive(String(rawBody ?? ''), header || undefined);
  } catch {
    throw new ApiError('Invalid webhook signature', { status: 401, code: 'INVALID_SIGNATURE' });
  }
  const now = Date.now();
  for (const [id, at] of seenEvents) if (now - at > SEEN_TTL_MS) seenEvents.delete(id);
  if (event.id) {
    if (seenEvents.has(event.id)) return null;
    seenEvents.set(event.id, now);
  }
  return event;
}

/** Test hook. */
export function __resetWebhookDedupe() { seenEvents.clear(); }
