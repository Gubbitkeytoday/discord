// ============================================================================
//  Polls
//
//  Discord's model, and the parts of it that actually matter:
//
//    - A poll IS a message. It is not an attachment to one, so it inherits the
//      channel's permissions, its edit/delete rules, and its place in history
//      for free.
//    - Results are hidden from nobody. Discord shows a running tally, so this
//      does too — there is no "secret ballot" mode to get wrong.
//    - A vote is retractable while the poll is open, and frozen the moment it
//      closes. Closing is the only irreversible step.
//    - Expiry is evaluated on read, not by a timer. A poll whose time has
//      passed is closed the next time anyone looks at it, which means a server
//      that was switched off over the weekend still behaves correctly.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { assertChannelAccess } from './access.js';

/** Discord's own limits, so a poll authored here would be valid there too. */
export const POLL_LIMITS = {
  question: 300,
  answerText: 55,
  answers: 10,
  minAnswers: 1,
  maxDurationHours: 24 * 32
};

const nowIso = () => new Date().toISOString();

/* --- reading ---------------------------------------------------------------- */

/**
 * Build the wire shape for one poll: question, answers with tallies, and what
 * *this* viewer voted for.
 *
 * The tally is computed rather than stored. A counter column would need to stay
 * correct across retracted votes, deleted answers and cascading user deletes;
 * counting rows cannot drift.
 */
export async function getPoll(messageId, viewerId = null) {
  const poll = await getQuery(`SELECT * FROM polls WHERE message_id = ?`, [messageId]);
  if (!poll) return null;

  const closed = await settleExpiry(poll);

  const answers = await allQuery(
    `SELECT a.id, a.position, a.text, a.emoji,
            (SELECT count(*) FROM poll_votes v WHERE v.answer_id = a.id) AS votes
       FROM poll_answers a
      WHERE a.message_id = ?
      ORDER BY a.position ASC`,
    [messageId]
  );

  const mine = viewerId
    ? await allQuery(
        `SELECT answer_id FROM poll_votes WHERE message_id = ? AND user_id = ?`,
        [messageId, viewerId]
      )
    : [];

  const totalVotes = answers.reduce((sum, a) => sum + a.votes, 0);
  // Distinct voters, not total votes: with allow_multiple a single person can
  // add several rows, and "12 votes from 4 people" is the honest phrasing.
  const voterRow = await getQuery(
    `SELECT count(DISTINCT user_id) AS n FROM poll_votes WHERE message_id = ?`, [messageId]
  );

  return {
    message_id: poll.message_id,
    channel_id: poll.channel_id,
    question: poll.question,
    allow_multiple: Boolean(poll.allow_multiple),
    expires_at: poll.expires_at,
    closed_at: closed,
    is_closed: Boolean(closed),
    total_votes: totalVotes,
    total_voters: voterRow?.n ?? 0,
    my_votes: mine.map((row) => row.answer_id),
    answers: answers.map((a) => ({
      id: a.id,
      position: a.position,
      text: a.text,
      emoji: a.emoji,
      votes: a.votes,
      // Percentages are of *voters*, so a multiple-choice poll can legitimately
      // sum above 100% — which is what Discord shows too.
      percent: voterRow?.n ? Math.round((a.votes / voterRow.n) * 100) : 0
    }))
  };
}

/** Attach polls to a batch of messages in one pass, for the history endpoint. */
export async function attachPolls(messages, viewerId = null) {
  const ids = messages.filter((m) => m.type === 'poll').map((m) => m.id);
  if (ids.length === 0) return messages;
  const polls = new Map();
  for (const id of ids) polls.set(id, await getPoll(id, viewerId));
  return messages.map((m) => (polls.has(m.id) ? { ...m, poll: polls.get(m.id) } : m));
}

/**
 * Close a poll whose deadline has passed. Returns the effective closed_at.
 *
 * Doing this lazily rather than on a timer means there is no scheduler to keep
 * alive and no drift if the process restarts — the first read after the
 * deadline settles it, and every later read sees a stable value.
 */
async function settleExpiry(poll) {
  if (poll.closed_at) return poll.closed_at;
  if (!poll.expires_at) return null;
  if (poll.expires_at > nowIso()) return null;

  await runQuery(
    `UPDATE polls SET closed_at = ? WHERE message_id = ? AND closed_at IS NULL`,
    [poll.expires_at, poll.message_id]
  );
  return poll.expires_at;
}

/* --- writing ---------------------------------------------------------------- */

export function validatePollInput({ question, answers, durationHours, allowMultiple }) {
  const trimmedQuestion = String(question ?? '').trim();
  if (!trimmedQuestion) throw new ApiError('A poll needs a question', { code: 'POLL_NO_QUESTION' });
  if (trimmedQuestion.length > POLL_LIMITS.question) {
    throw new ApiError(`The question may be at most ${POLL_LIMITS.question} characters`,
      { code: 'POLL_QUESTION_TOO_LONG' });
  }

  const list = (Array.isArray(answers) ? answers : [])
    .map((a) => (typeof a === 'string' ? { text: a } : a ?? {}))
    .map((a) => ({ text: String(a.text ?? '').trim(), emoji: a.emoji ?? null }))
    .filter((a) => a.text.length > 0);

  if (list.length <= POLL_LIMITS.minAnswers) {
    throw new ApiError('A poll needs at least two answers', { code: 'POLL_TOO_FEW_ANSWERS' });
  }
  if (list.length > POLL_LIMITS.answers) {
    throw new ApiError(`A poll may have at most ${POLL_LIMITS.answers} answers`,
      { code: 'POLL_TOO_MANY_ANSWERS' });
  }
  for (const a of list) {
    if (a.text.length > POLL_LIMITS.answerText) {
      throw new ApiError(`An answer may be at most ${POLL_LIMITS.answerText} characters`,
        { code: 'POLL_ANSWER_TOO_LONG' });
    }
  }

  let expiresAt = null;
  if (durationHours !== null && durationHours !== undefined && durationHours !== '') {
    const hours = Number(durationHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > POLL_LIMITS.maxDurationHours) {
      throw new ApiError(`Duration must be between 1 hour and ${POLL_LIMITS.maxDurationHours} hours`,
        { code: 'POLL_BAD_DURATION' });
    }
    expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  }

  return {
    question: trimmedQuestion,
    answers: list,
    expiresAt,
    allowMultiple: Boolean(allowMultiple)
  };
}

/**
 * Persist the poll that belongs to a message the caller has already created.
 * Kept separate from message creation so the message service stays the single
 * place that writes a message row.
 */
export async function createPollForMessage({ messageId, channelId, input }) {
  const clean = validatePollInput(input);
  await writePollRows({ messageId, channelId, clean });
  return getPoll(messageId);
}

/**
 * The raw insert, without its own transaction, so the message service can call
 * it from inside the transaction that writes the message row. A poll and its
 * message must appear together or not at all.
 */
export async function writePollRows({ messageId, channelId, clean }) {
  {
    await runQuery(
      `INSERT INTO polls (message_id, channel_id, question, allow_multiple, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [messageId, channelId, clean.question, clean.allowMultiple ? 1 : 0, clean.expiresAt]
    );
    let position = 0;
    for (const answer of clean.answers) {
      await runQuery(
        `INSERT INTO poll_answers (id, message_id, position, text, emoji) VALUES (?, ?, ?, ?, ?)`,
        [generateId(), messageId, position++, answer.text, answer.emoji]
      );
    }
  }
}

/**
 * Cast or retract a vote.
 *
 * `answerIds` is the caller's complete intended selection, not a delta. Sending
 * the whole set makes the operation idempotent: a retried request produces the
 * same state instead of toggling a vote back off, which matters on a flaky
 * connection where the client cannot tell whether the first attempt landed.
 */
export async function vote({ messageId, userId, answerIds }) {
  const poll = await getQuery(`SELECT * FROM polls WHERE message_id = ?`, [messageId]);
  if (!poll) throw ApiError.notFound('Poll');

  // Voting is a read of the channel plus a write of your own row; requiring
  // SEND_MESSAGES would stop read-only members voting, which Discord allows.
  await assertChannelAccess({ channelId: poll.channel_id, userId });

  if (await settleExpiry(poll) || poll.closed_at) {
    throw new ApiError('This poll has closed', { status: 409, code: 'POLL_CLOSED' });
  }

  const wanted = [...new Set(Array.isArray(answerIds) ? answerIds : [answerIds])]
    .filter(Boolean).map(String);

  if (!poll.allow_multiple && wanted.length > 1) {
    throw new ApiError('This poll allows one answer', { code: 'POLL_SINGLE_CHOICE' });
  }

  if (wanted.length) {
    const valid = await allQuery(
      `SELECT id FROM poll_answers WHERE message_id = ?`, [messageId]
    );
    const allowed = new Set(valid.map((row) => row.id));
    for (const id of wanted) {
      if (!allowed.has(id)) throw ApiError.notFound('Poll answer');
    }
  }

  await transaction(async () => {
    // Replace the whole selection rather than diffing it — same end state,
    // far less to get wrong, and it makes an empty array mean "retract".
    await runQuery(`DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?`,
      [messageId, userId]);
    for (const answerId of wanted) {
      await runQuery(
        `INSERT INTO poll_votes (message_id, answer_id, user_id) VALUES (?, ?, ?)`,
        [messageId, answerId, userId]
      );
    }
  });

  return getPoll(messageId, userId);
}

/** Who picked a given answer — Discord lets you expand this per answer. */
export async function listVoters({ messageId, answerId, userId, limit = 100 }) {
  const poll = await getQuery(`SELECT * FROM polls WHERE message_id = ?`, [messageId]);
  if (!poll) throw ApiError.notFound('Poll');
  await assertChannelAccess({ channelId: poll.channel_id, userId });

  return allQuery(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, v.created_at
       FROM poll_votes v JOIN users u ON u.id = v.user_id
      WHERE v.message_id = ? AND v.answer_id = ?
      ORDER BY v.created_at ASC
      LIMIT ?`,
    [messageId, answerId, Math.min(Number(limit) || 100, 200)]
  );
}

/**
 * End a poll early. The author may do this, and so may anyone who could delete
 * the message — the same people who can already remove it outright, so this
 * grants no new power.
 */
export async function closePoll({ messageId, userId }) {
  const poll = await getQuery(`SELECT * FROM polls WHERE message_id = ?`, [messageId]);
  if (!poll) throw ApiError.notFound('Poll');

  const message = await getQuery(
    `SELECT user_id FROM messages WHERE id = ? AND deleted_at IS NULL`, [messageId]
  );
  if (!message) throw ApiError.notFound('Message');

  if (message.user_id !== userId) {
    await assertChannelAccess({
      channelId: poll.channel_id, userId, permission: 'MANAGE_MESSAGES'
    });
  } else {
    await assertChannelAccess({ channelId: poll.channel_id, userId });
  }

  if (poll.closed_at) return getPoll(messageId, userId);

  await runQuery(`UPDATE polls SET closed_at = ? WHERE message_id = ?`, [nowIso(), messageId]);
  return getPoll(messageId, userId);
}
