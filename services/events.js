// ============================================================================
//  Scheduled events
//
//  Discord's lifecycle: scheduled → active → completed, or cancelled from
//  either of the first two. Two of those transitions are automatic:
//
//    - `active` when starts_at passes and the event is held in a voice channel
//      (an external event has nobody to "start" it, so it stays scheduled until
//      its end time)
//    - `completed` when ends_at passes, or starts_at + 1h for events without one
//
//  Both are evaluated on read, like poll expiry: no scheduler to babysit, and a
//  server that was down at the moment of transition catches up the first time
//  anyone looks.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { has } from '../lib/permissions.js';
import { resolvePermissions } from './guilds.js';

export const EVENT_LIMITS = {
  name: 100,
  description: 1000,
  location: 100,
  /** Discord lets you schedule up to 5 years out; a decade is plenty of slack. */
  maxYearsAhead: 10
};

const HOUR_MS = 3600 * 1000;
const nowIso = () => new Date().toISOString();

/* --- permissions -------------------------------------------------------------- */

async function assertMember(serverId, userId) {
  const resolved = await resolvePermissions({ userId, serverId });
  if (!resolved.isMember) throw ApiError.forbidden('You are not a member of this server');
  return resolved;
}

/** Discord gates event management on MANAGE_EVENTS; we map it to MANAGE_GUILD. */
async function assertCanManage(serverId, userId) {
  const resolved = await assertMember(serverId, userId);
  if (!has(resolved.permissions, 'MANAGE_GUILD') && !has(resolved.permissions, 'ADMINISTRATOR')) {
    throw ApiError.forbidden('Missing permission: MANAGE_GUILD');
  }
  return resolved;
}

/* --- lifecycle ---------------------------------------------------------------- */

/**
 * Advance an event's status according to the clock. Returns the row with the
 * status it *should* have; the database is updated only if it changed.
 */
async function settle(event) {
  if (event.status === 'completed' || event.status === 'cancelled') return event;

  const now = Date.now();
  const starts = new Date(event.starts_at).getTime();
  const ends = event.ends_at ? new Date(event.ends_at).getTime() : starts + HOUR_MS;

  let next = event.status;
  if (now >= ends) next = 'completed';
  else if (now >= starts && event.channel_id) next = 'active';

  if (next !== event.status) {
    await runQuery(
      `UPDATE scheduled_events SET status = ?, updated_at = ? WHERE id = ? AND status = ?`,
      [next, nowIso(), event.id, event.status]
    );
    return { ...event, status: next };
  }
  return event;
}

/* --- reading -------------------------------------------------------------------- */

async function shape(row, viewerId) {
  const settled = await settle(row);
  const [count, mine, creator, channel] = await Promise.all([
    getQuery(`SELECT count(*) AS n FROM event_interest WHERE event_id = ?`, [row.id]),
    viewerId
      ? getQuery(`SELECT 1 FROM event_interest WHERE event_id = ? AND user_id = ?`, [row.id, viewerId])
      : null,
    row.creator_id
      ? getQuery(`SELECT id, username, display_name, avatar_url FROM users WHERE id = ?`, [row.creator_id])
      : null,
    row.channel_id
      ? getQuery(`SELECT id, name, type FROM channels WHERE id = ? AND deleted_at IS NULL`, [row.channel_id])
      : null
  ]);

  return {
    id: settled.id,
    server_id: settled.server_id,
    channel_id: settled.channel_id,
    channel: channel ?? null,
    creator: creator ?? null,
    name: settled.name,
    description: settled.description,
    location: settled.location,
    image_url: settled.image_url,
    starts_at: settled.starts_at,
    ends_at: settled.ends_at,
    status: settled.status,
    interested_count: count?.n ?? 0,
    interested: Boolean(mine),
    created_at: settled.created_at
  };
}

export async function getEvent(eventId, viewerId = null) {
  const row = await getQuery(`SELECT * FROM scheduled_events WHERE id = ?`, [eventId]);
  if (!row) throw ApiError.notFound('Event');
  await assertMember(row.server_id, viewerId);
  return shape(row, viewerId);
}

/**
 * Upcoming and live events for a server, soonest first. Completed and cancelled
 * events are excluded by default — Discord's list is forward-looking — but a
 * caller can ask for them for an archive view.
 */
export async function listEvents(serverId, { viewerId = null, includePast = false } = {}) {
  await assertMember(serverId, viewerId);
  const rows = await allQuery(
    `SELECT * FROM scheduled_events WHERE server_id = ? ORDER BY starts_at ASC`, [serverId]
  );
  const shaped = [];
  for (const row of rows) {
    const event = await shape(row, viewerId);
    if (!includePast && (event.status === 'completed' || event.status === 'cancelled')) continue;
    shaped.push(event);
  }
  return shaped;
}

/** Who is interested — for the "12 interested" expander. */
export async function listInterested(eventId, viewerId, { limit = 100 } = {}) {
  const row = await getQuery(`SELECT server_id FROM scheduled_events WHERE id = ?`, [eventId]);
  if (!row) throw ApiError.notFound('Event');
  await assertMember(row.server_id, viewerId);
  return allQuery(
    `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM event_interest i JOIN users u ON u.id = i.user_id
      WHERE i.event_id = ? ORDER BY i.created_at ASC LIMIT ?`,
    [eventId, Math.min(Number(limit) || 100, 500)]
  );
}

/* --- writing -------------------------------------------------------------------- */

function validate(input, { partial = false } = {}) {
  const out = {};

  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new ApiError('An event needs a name', { code: 'EVENT_NO_NAME' });
    if (name.length > EVENT_LIMITS.name) {
      throw new ApiError(`Name may be at most ${EVENT_LIMITS.name} characters`, { code: 'EVENT_NAME_TOO_LONG' });
    }
    out.name = name;
  }

  if (input.description !== undefined) {
    const description = input.description === null ? null : String(input.description).trim();
    if (description && description.length > EVENT_LIMITS.description) {
      throw new ApiError(`Description may be at most ${EVENT_LIMITS.description} characters`,
        { code: 'EVENT_DESCRIPTION_TOO_LONG' });
    }
    out.description = description || null;
  }

  if (input.location !== undefined) {
    const location = input.location === null ? null : String(input.location).trim();
    if (location && location.length > EVENT_LIMITS.location) {
      throw new ApiError(`Location may be at most ${EVENT_LIMITS.location} characters`,
        { code: 'EVENT_LOCATION_TOO_LONG' });
    }
    out.location = location || null;
  }

  if (input.image_url !== undefined) out.image_url = input.image_url || null;
  if (input.channel_id !== undefined) out.channel_id = input.channel_id || null;

  if (!partial || input.starts_at !== undefined) {
    const starts = new Date(input.starts_at);
    if (Number.isNaN(starts.getTime())) {
      throw new ApiError('starts_at must be a valid date', { code: 'EVENT_BAD_START' });
    }
    const limit = Date.now() + EVENT_LIMITS.maxYearsAhead * 365 * 24 * HOUR_MS;
    if (starts.getTime() > limit) {
      throw new ApiError('That is too far in the future', { code: 'EVENT_TOO_FAR' });
    }
    out.starts_at = starts.toISOString();
  }

  if (input.ends_at !== undefined) {
    if (input.ends_at === null || input.ends_at === '') out.ends_at = null;
    else {
      const ends = new Date(input.ends_at);
      if (Number.isNaN(ends.getTime())) {
        throw new ApiError('ends_at must be a valid date', { code: 'EVENT_BAD_END' });
      }
      out.ends_at = ends.toISOString();
    }
  }

  return out;
}

/** The channel, if any, must be a voice-ish channel in this server. */
async function assertChannel(serverId, channelId) {
  if (!channelId) return;
  const channel = await getQuery(
    `SELECT id, type FROM channels WHERE id = ? AND server_id = ? AND deleted_at IS NULL`,
    [channelId, serverId]
  );
  if (!channel) throw ApiError.notFound('Channel');
  if (!['voice', 'stage'].includes(channel.type)) {
    throw new ApiError('An event can only be held in a voice or stage channel', { code: 'EVENT_BAD_CHANNEL' });
  }
}

export async function createEvent({ serverId, userId, input }) {
  await assertCanManage(serverId, userId);
  const clean = validate(input);

  // An external event needs a location; a channel event needs a channel.
  if (!clean.channel_id && !clean.location) {
    throw new ApiError('Choose a voice channel or give a location', { code: 'EVENT_NO_PLACE' });
  }
  await assertChannel(serverId, clean.channel_id);

  if (clean.ends_at && clean.ends_at <= clean.starts_at) {
    throw new ApiError('The event must end after it starts', { code: 'EVENT_ENDS_BEFORE_START' });
  }
  // Only the past is refused; "starts in one minute" is fine.
  if (new Date(clean.starts_at).getTime() < Date.now() - 60_000) {
    throw new ApiError('The start time is in the past', { code: 'EVENT_IN_PAST' });
  }

  const id = generateId();
  await runQuery(
    `INSERT INTO scheduled_events
       (id, server_id, channel_id, creator_id, name, description, location, image_url, starts_at, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, serverId, clean.channel_id ?? null, userId, clean.name, clean.description ?? null,
     clean.location ?? null, clean.image_url ?? null, clean.starts_at, clean.ends_at ?? null]
  );

  // The creator is interested by definition.
  await runQuery(`INSERT OR IGNORE INTO event_interest (event_id, user_id) VALUES (?, ?)`, [id, userId]);
  return getEvent(id, userId);
}

export async function updateEvent({ eventId, userId, patch }) {
  const row = await getQuery(`SELECT * FROM scheduled_events WHERE id = ?`, [eventId]);
  if (!row) throw ApiError.notFound('Event');
  await assertCanManage(row.server_id, userId);
  if (row.status === 'completed' || row.status === 'cancelled') {
    throw new ApiError('This event is over', { status: 409, code: 'EVENT_FINISHED' });
  }

  const clean = validate(patch, { partial: true });
  if (clean.channel_id !== undefined) await assertChannel(row.server_id, clean.channel_id);

  const merged = { ...row, ...clean };
  if (merged.ends_at && merged.ends_at <= merged.starts_at) {
    throw new ApiError('The event must end after it starts', { code: 'EVENT_ENDS_BEFORE_START' });
  }
  if (!merged.channel_id && !merged.location) {
    throw new ApiError('Choose a voice channel or give a location', { code: 'EVENT_NO_PLACE' });
  }

  const sets = Object.keys(clean).map((key) => `${key} = ?`);
  if (sets.length) {
    await runQuery(
      `UPDATE scheduled_events SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
      [...Object.values(clean), nowIso(), eventId]
    );
  }
  return getEvent(eventId, userId);
}

/** Cancel, or for an already-live event, end it. Both are terminal. */
export async function cancelEvent({ eventId, userId }) {
  const row = await getQuery(`SELECT * FROM scheduled_events WHERE id = ?`, [eventId]);
  if (!row) throw ApiError.notFound('Event');
  await assertCanManage(row.server_id, userId);

  const settled = await settle(row);
  const target = settled.status === 'active' ? 'completed' : 'cancelled';
  await runQuery(
    `UPDATE scheduled_events SET status = ?, updated_at = ? WHERE id = ?`,
    [target, nowIso(), eventId]
  );
  return getEvent(eventId, userId);
}

/** Toggle interest. Idempotent in each direction. */
export async function setInterest({ eventId, userId, interested }) {
  const row = await getQuery(`SELECT * FROM scheduled_events WHERE id = ?`, [eventId]);
  if (!row) throw ApiError.notFound('Event');
  await assertMember(row.server_id, userId);

  const settled = await settle(row);
  if (settled.status === 'completed' || settled.status === 'cancelled') {
    throw new ApiError('This event is over', { status: 409, code: 'EVENT_FINISHED' });
  }

  if (interested) {
    await runQuery(`INSERT OR IGNORE INTO event_interest (event_id, user_id) VALUES (?, ?)`, [eventId, userId]);
  } else {
    await runQuery(`DELETE FROM event_interest WHERE event_id = ? AND user_id = ?`, [eventId, userId]);
  }
  return getEvent(eventId, userId);
}

/**
 * Events starting within `withinMs` that have not yet been reminded about.
 * The reminder job calls this; it tracks what it has already sent in memory
 * because a reminder that is sent twice after a restart is a minor annoyance
 * and a column to prevent it is not worth the write on every tick.
 */
export async function upcomingWithin(withinMs) {
  const now = Date.now();
  return allQuery(
    `SELECT * FROM scheduled_events
      WHERE status = 'scheduled' AND starts_at > ? AND starts_at <= ?`,
    [new Date(now).toISOString(), new Date(now + withinMs).toISOString()]
  );
}
