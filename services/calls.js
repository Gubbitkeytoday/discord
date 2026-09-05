// ============================================================================
//  Calls in DMs and group DMs.
//
//  Discord's model, and ours: a call is not a second voice implementation. The
//  people who answer land in `voice_states` keyed by the DM channel, exactly as
//  they would in a guild voice channel, so the existing mesh, mute/deafen
//  flags, screen share and spatial audio all work untouched.
//
//  What this service owns is the *ring*: who started the call, who is still
//  being rung, who declined, and when it ended. That record is what becomes the
//  `call` system message left behind in the conversation — "Call ended · 4m 12s"
//  or "You missed a call from Mai".
//
//  Invariants
//    * At most one open call per channel (a partial unique index enforces it,
//      and startCall settles a stale one first rather than failing).
//    * Every recipient of the channel gets a participant row when the call
//      starts, so a decline is distinguishable from never answering.
//    * The call ends when the last joined participant leaves, or when nobody
//      ever answered — settled on read as well as on write, so a server that
//      restarts mid-call does not leave a call ringing forever.
// ============================================================================

import { getQuery, allQuery, runQuery } from '../db.js';
import { ApiError } from '../lib/httpUtils.js';
import { generateId } from '../lib/snowflake.js';
import { assertChannelAccess } from './access.js';
import { createMessage } from './messages.js';

// A call nobody answers stops ringing by itself. Discord gives up at ~30s; we
// keep the same feel but settle lazily, on the next read or write.
const RING_TIMEOUT_MS = 45_000;

const nowIso = () => new Date().toISOString();

/** The channel must be a DM or group DM, and the caller must be in it. */
async function assertDmChannel(channelId, userId) {
  const { channel } = await assertChannelAccess({ channelId, userId, permission: 'SEND_MESSAGES' });
  if (channel.type !== 'dm' && channel.type !== 'group_dm') {
    throw new ApiError('Calls are only for direct messages — use a voice channel here', {
      status: 400, code: 'NOT_A_DM'
    });
  }
  return channel;
}

/** Everyone in the conversation, including the caller. */
async function recipientsOf(channelId) {
  const rows = await allQuery(
    `SELECT user_id FROM channel_recipients WHERE channel_id = ?`, [channelId]
  );
  return rows.map((r) => r.user_id);
}

/**
 * Load the open call for a channel, closing it first if it has gone stale.
 * Returns null when there is no live call.
 */
export async function getActiveCall(channelId) {
  const call = await getQuery(
    `SELECT * FROM calls WHERE channel_id = ? AND ended_at IS NULL`, [channelId]
  );
  if (!call) return null;

  const joined = await allQuery(
    `SELECT user_id FROM call_participants WHERE call_id = ? AND state = 'joined'`, [call.id]
  );
  if (joined.length > 0) return { ...call, participants: await listParticipants(call.id) };

  // Nobody is in it. Either it is still ringing, or the ring expired.
  const age = Date.now() - new Date(call.started_at).getTime();
  if (age < RING_TIMEOUT_MS) {
    const ringing = await getQuery(
      `SELECT 1 FROM call_participants WHERE call_id = ? AND state = 'ringing'`, [call.id]
    );
    if (ringing) return { ...call, participants: await listParticipants(call.id) };
  }
  await endCallRow(call, 'missed');
  return null;
}

async function listParticipants(callId) {
  return allQuery(
    `SELECT cp.user_id, cp.state, cp.joined_at, cp.left_at,
            u.username, u.display_name, u.avatar_url
       FROM call_participants cp
       JOIN users u ON u.id = cp.user_id
      WHERE cp.call_id = ?
      ORDER BY cp.joined_at IS NULL, cp.joined_at`,
    [callId]
  );
}

/**
 * Close a call and leave the system message behind. `outcome` is 'missed' when
 * nobody ever answered — Discord words that one differently, and so do we.
 */
async function endCallRow(call, outcome = 'ended') {
  const endedAt = nowIso();
  await runQuery(`UPDATE calls SET ended_at = ? WHERE id = ? AND ended_at IS NULL`, [endedAt, call.id]);
  await runQuery(
    `UPDATE call_participants SET state = 'missed' WHERE call_id = ? AND state = 'ringing'`, [call.id]
  );
  await runQuery(
    `UPDATE call_participants SET state = 'left', left_at = ? WHERE call_id = ? AND state = 'joined'`,
    [endedAt, call.id]
  );
  // Nobody is left in the voice room either.
  await runQuery(`UPDATE voice_states SET channel_id = NULL WHERE channel_id = ?`, [call.channel_id]);

  const seconds = Math.max(0, Math.round((new Date(endedAt) - new Date(call.started_at)) / 1000));
  // The content is a machine-readable summary; the client renders the phrasing
  // in the viewer's language rather than storing Thai or English in the row.
  const content = outcome === 'missed' ? 'missed' : String(seconds);
  const message = await createMessage({
    channelId: call.channel_id,
    userId: call.initiator_id,
    content,
    type: 'call',
    skipModeration: true
  });
  await runQuery(`UPDATE calls SET message_id = ? WHERE id = ?`, [message.id, call.id]);
  return { ...call, ended_at: endedAt, outcome, message };
}

/**
 * Start ringing. Returns the existing call instead of failing when one is
 * already open — pressing the call button twice should join, not error.
 */
export async function startCall({ channelId, userId, video = false }) {
  await assertDmChannel(channelId, userId);

  const existing = await getActiveCall(channelId);
  if (existing) {
    await joinCall({ channelId, userId });
    return { call: await getActiveCall(channelId), created: false };
  }

  const recipients = await recipientsOf(channelId);
  if (recipients.length < 2) {
    throw new ApiError('There is nobody to call in this conversation', {
      status: 400, code: 'CALL_NO_RECIPIENTS'
    });
  }

  const id = generateId();
  await runQuery(
    `INSERT INTO calls (id, channel_id, initiator_id, video) VALUES (?, ?, ?, ?)`,
    [id, channelId, userId, video ? 1 : 0]
  );
  for (const recipientId of recipients) {
    await runQuery(
      `INSERT INTO call_participants (call_id, user_id, state, joined_at)
       VALUES (?, ?, ?, ?)`,
      [id, recipientId,
        recipientId === userId ? 'joined' : 'ringing',
        recipientId === userId ? nowIso() : null]
    );
  }
  const call = await getQuery(`SELECT * FROM calls WHERE id = ?`, [id]);
  return { call: { ...call, participants: await listParticipants(id) }, created: true };
}

/** Answer a ringing call (or rejoin one already in progress). */
export async function joinCall({ channelId, userId }) {
  await assertDmChannel(channelId, userId);
  const call = await getActiveCall(channelId);
  if (!call) throw new ApiError('That call has already ended', { status: 410, code: 'CALL_ENDED' });

  await runQuery(
    `INSERT INTO call_participants (call_id, user_id, state, joined_at)
     VALUES (?, ?, 'joined', ?)
     ON CONFLICT (call_id, user_id)
     DO UPDATE SET state = 'joined', joined_at = COALESCE(call_participants.joined_at, excluded.joined_at),
                   left_at = NULL`,
    [call.id, userId, nowIso()]
  );
  return { ...call, participants: await listParticipants(call.id) };
}

/** Decline without answering. The call keeps ringing for everyone else. */
export async function declineCall({ channelId, userId }) {
  await assertDmChannel(channelId, userId);
  const call = await getActiveCall(channelId);
  if (!call) return null;

  await runQuery(
    `UPDATE call_participants SET state = 'declined' WHERE call_id = ? AND user_id = ? AND state = 'ringing'`,
    [call.id, userId]
  );
  // In a 1:1 DM a decline is the end of it; settle immediately rather than
  // leaving the caller listening to a ring nobody will ever answer.
  const stillWanted = await getQuery(
    `SELECT 1 FROM call_participants WHERE call_id = ? AND state IN ('ringing','joined')
      AND user_id <> ? LIMIT 1`,
    [call.id, call.initiator_id]
  );
  if (!stillWanted) return endCallRow(call, 'missed');
  return { ...call, participants: await listParticipants(call.id) };
}

/**
 * Leave the call. When the last person with an answered seat leaves, the call
 * itself ends and the system message is written.
 */
export async function leaveCall({ channelId, userId }) {
  const call = await getQuery(
    `SELECT * FROM calls WHERE channel_id = ? AND ended_at IS NULL`, [channelId]
  );
  if (!call) return null;

  await runQuery(
    `UPDATE call_participants SET state = 'left', left_at = ? WHERE call_id = ? AND user_id = ?`,
    [nowIso(), call.id, userId]
  );
  await runQuery(`UPDATE voice_states SET channel_id = NULL WHERE user_id = ? AND channel_id = ?`,
    [userId, channelId]);

  const remaining = await getQuery(
    `SELECT 1 FROM call_participants WHERE call_id = ? AND state = 'joined' LIMIT 1`, [call.id]
  );
  if (remaining) return { ...call, participants: await listParticipants(call.id) };
  // Whether anyone ever answered decides the wording of the system message.
  const answered = await getQuery(
    `SELECT 1 FROM call_participants WHERE call_id = ? AND joined_at IS NOT NULL
       AND user_id <> ? LIMIT 1`,
    [call.id, call.initiator_id]
  );
  return endCallRow(call, answered ? 'ended' : 'missed');
}
