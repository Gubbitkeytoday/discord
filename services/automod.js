// ============================================================================
//  AutoMod — rule evaluation on the message-send path, plus slowmode and
//  timeout enforcement.
//
//  Everything here runs before a message is persisted, so a blocked message
//  never exists. Rules are per-guild rows in automod_rules.
// ============================================================================

import { runQuery, getQuery, allQuery } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { has, isActiveTimeout } from '../lib/permissions.js';

const LINK = /https?:\/\/[^\s<]+/gi;
const MENTION = /<@[!&]?[\w-]+>/g;

// Recent messages per (channel, user) for spam heuristics. Ephemeral by design.
const recentSends = new Map();
const SPAM_WINDOW_MS = 10_000;

function rememberSend(channelId, userId, content) {
  const key = `${channelId}:${userId}`;
  const now = Date.now();
  const list = (recentSends.get(key) ?? []).filter((e) => now - e.at < SPAM_WINDOW_MS);
  list.push({ at: now, content });
  recentSends.set(key, list);
  return list;
}

function safeRegex(source) {
  // A user-supplied pattern must not be able to hang the server. Length is
  // capped and the pattern is rejected if it contains nested quantifiers, the
  // classic catastrophic-backtracking shape.
  if (!source || source.length > 200) return null;
  if (/(\(\?<)|(\(\?\<)/.test(source)) return null;             // no lookbehind
  if (/(\([^)]*[+*]\)[+*])|(\[[^\]]*\][+*][+*])/.test(source)) return null;
  try { return new RegExp(source, 'iu'); } catch { return null; }
}

export async function listRules(serverId) {
  const rows = await allQuery(
    `SELECT * FROM automod_rules WHERE server_id = ? ORDER BY created_at DESC`, [serverId]
  );
  return rows.map(inflate);
}

function inflate(row) {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    trigger_metadata: safeJson(row.trigger_metadata, {}),
    actions: safeJson(row.actions, []),
    exempt_roles: safeJson(row.exempt_roles, []),
    exempt_channels: safeJson(row.exempt_channels, [])
  };
}

function safeJson(value, fallback) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

const TRIGGERS = ['keyword', 'spam', 'mention_spam', 'link', 'regex'];
const ACTIONS = ['block', 'alert', 'timeout'];

export async function createRule({ serverId, actorId, rule }) {
  if (!TRIGGERS.includes(rule?.trigger_type)) {
    throw new ApiError(`trigger_type ต้องเป็นหนึ่งใน ${TRIGGERS.join(', ')}`, { code: 'INVALID_TRIGGER' });
  }
  const actions = (rule.actions ?? ['block']).filter((a) => ACTIONS.includes(a));
  if (actions.length === 0) {
    throw new ApiError(`actions ต้องมีอย่างน้อยหนึ่งใน ${ACTIONS.join(', ')}`, { code: 'INVALID_ACTION' });
  }
  if (rule.trigger_type === 'regex' && !safeRegex(rule.trigger_metadata?.pattern)) {
    throw new ApiError('regex ไม่ปลอดภัยหรือไม่ถูกต้อง', { code: 'INVALID_REGEX' });
  }

  const id = generateId();
  await runQuery(
    `INSERT INTO automod_rules (id, server_id, name, event_type, trigger_type,
                                trigger_metadata, actions, enabled,
                                exempt_roles, exempt_channels, creator_id)
     VALUES (?, ?, ?, 'message_send', ?, ?, ?, ?, ?, ?, ?)`,
    [id, serverId, String(rule.name ?? 'กฎใหม่').slice(0, 100), rule.trigger_type,
     JSON.stringify(rule.trigger_metadata ?? {}), JSON.stringify(actions),
     rule.enabled === false ? 0 : 1,
     JSON.stringify(rule.exempt_roles ?? []), JSON.stringify(rule.exempt_channels ?? []),
     actorId]
  );
  return inflate(await getQuery(`SELECT * FROM automod_rules WHERE id = ?`, [id]));
}

export async function updateRule({ serverId, ruleId, patch }) {
  const existing = await getQuery(
    `SELECT * FROM automod_rules WHERE id = ? AND server_id = ?`, [ruleId, serverId]
  );
  if (!existing) throw ApiError.notFound('Rule');

  if (patch.trigger_type === 'regex' && !safeRegex(patch.trigger_metadata?.pattern)) {
    throw new ApiError('regex ไม่ปลอดภัยหรือไม่ถูกต้อง', { code: 'INVALID_REGEX' });
  }

  const fields = {
    name: patch.name,
    trigger_type: patch.trigger_type,
    trigger_metadata: patch.trigger_metadata ? JSON.stringify(patch.trigger_metadata) : undefined,
    actions: patch.actions ? JSON.stringify(patch.actions) : undefined,
    enabled: patch.enabled === undefined ? undefined : (patch.enabled ? 1 : 0),
    exempt_roles: patch.exempt_roles ? JSON.stringify(patch.exempt_roles) : undefined,
    exempt_channels: patch.exempt_channels ? JSON.stringify(patch.exempt_channels) : undefined
  };

  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (sets.length) {
    params.push(ruleId);
    await runQuery(`UPDATE automod_rules SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  return inflate(await getQuery(`SELECT * FROM automod_rules WHERE id = ?`, [ruleId]));
}

export async function deleteRule({ serverId, ruleId }) {
  await runQuery(`DELETE FROM automod_rules WHERE id = ? AND server_id = ?`, [ruleId, serverId]);
  return { success: true };
}

// --- enforcement -------------------------------------------------------------

/**
 * Evaluate every enabled rule against a pending message.
 *
 * @returns {Promise<{blocked: boolean, rule?: object, reason?: string, actions: string[]}>}
 */
export async function evaluate({ serverId, channelId, userId, content, memberRoleIds = [], permissions = '0' }) {
  if (!serverId) return { blocked: false, actions: [] };

  // Anyone who can manage messages is trusted; otherwise moderators would trip
  // their own keyword filters while moderating.
  if (has(permissions, 'MANAGE_MESSAGES') || has(permissions, 'ADMINISTRATOR')) {
    return { blocked: false, actions: [] };
  }

  const rules = await listRules(serverId);
  if (rules.length === 0) return { blocked: false, actions: [] };

  const history = rememberSend(channelId, userId, content);
  const lowered = String(content ?? '').toLowerCase();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.exempt_channels.includes(channelId)) continue;
    if (rule.exempt_roles.some((roleId) => memberRoleIds.includes(roleId))) continue;

    const hit = matches(rule, { content, lowered, history });
    if (!hit) continue;

    if (rule.actions.includes('timeout')) {
      const seconds = Number(rule.trigger_metadata?.timeout_seconds) || 300;
      await runQuery(
        `UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?`,
        [new Date(Date.now() + seconds * 1000).toISOString(), serverId, userId]
      );
    }

    return {
      blocked: rule.actions.includes('block'),
      rule,
      reason: hit,
      actions: rule.actions
    };
  }

  return { blocked: false, actions: [] };
}

function matches(rule, { content, lowered, history }) {
  const meta = rule.trigger_metadata ?? {};

  switch (rule.trigger_type) {
    case 'keyword': {
      const words = (meta.keywords ?? []).map((k) => String(k).toLowerCase()).filter(Boolean);
      const found = words.find((word) => lowered.includes(word));
      return found ? `คำที่ถูกกรอง: "${found}"` : null;
    }
    case 'regex': {
      const pattern = safeRegex(meta.pattern);
      return pattern?.test(content) ? `ตรงกับรูปแบบที่ถูกกรอง` : null;
    }
    case 'link': {
      const links = content.match(LINK) ?? [];
      if (links.length === 0) return null;
      const allow = (meta.allowed_domains ?? []).map((d) => String(d).toLowerCase());
      if (allow.length === 0) return 'ห้ามส่งลิงก์ในเซิร์ฟเวอร์นี้';
      const bad = links.find((link) => {
        try {
          const host = new URL(link).hostname.toLowerCase();
          return !allow.some((d) => host === d || host.endsWith(`.${d}`));
        } catch { return true; }
      });
      return bad ? `ลิงก์ที่ไม่อนุญาต: ${bad}` : null;
    }
    case 'mention_spam': {
      const limit = Number(meta.max_mentions) || 5;
      const count = (content.match(MENTION) ?? []).length;
      return count > limit ? `พูดถึงคนอื่นมากเกินไป (${count} > ${limit})` : null;
    }
    case 'spam': {
      const limit = Number(meta.max_messages) || 5;
      if (history.length > limit) return `ส่งข้อความถี่เกินไป (${history.length} ใน 10 วินาที)`;
      // Repeating the identical message is spam even under the rate limit.
      const duplicates = history.filter((e) => e.content === content).length;
      return duplicates >= 3 ? 'ส่งข้อความซ้ำเดิมหลายครั้ง' : null;
    }
    default:
      return null;
  }
}

/** Record a blocked message so moderators can see what AutoMod caught. */
export async function logHit({ serverId, userId, channelId, rule, reason, content }) {
  await runQuery(
    `INSERT INTO audit_logs (id, server_id, user_id, action_type, target_type, target_id, changes, reason)
     VALUES (?, ?, ?, 'AUTOMOD_BLOCK', 'user', ?, ?, ?)`,
    [generateId(), serverId, userId, userId,
     JSON.stringify([{ key: 'rule', new: rule?.name ?? 'unknown' },
                     { key: 'content', new: String(content ?? '').slice(0, 200) },
                     { key: 'channel', new: channelId }]),
     reason ?? null]
  );
}

// --- slowmode & timeout ------------------------------------------------------

/**
 * Enforce channel slowmode and member timeouts.
 * Throws with a 429/403 rather than returning, since both are hard stops.
 */
export async function assertCanSpeak({ serverId, channelId, userId, permissions = '0' }) {
  // An administrator is never silenced by a timeout, matching Discord.
  if (serverId && !has(permissions, 'ADMINISTRATOR')) {
    const member = await getQuery(
      `SELECT timeout_until FROM server_members WHERE server_id = ? AND user_id = ?`,
      [serverId, userId]
    );
    // Parsed, not string-compared: an offset like +07:00 sorts wrong as text.
    if (isActiveTimeout(member?.timeout_until)) {
      throw new ApiError('คุณถูกพักการใช้งานชั่วคราว ยังส่งข้อความไม่ได้', {
        status: 403, code: 'TIMED_OUT',
        details: { until: member.timeout_until }
      });
    }
  }

  // MANAGE_MESSAGES / MANAGE_CHANNELS bypass slowmode, as on Discord.
  if (has(permissions, 'MANAGE_MESSAGES') || has(permissions, 'MANAGE_CHANNELS')) return;

  const channel = await getQuery(
    `SELECT rate_limit_per_user FROM channels WHERE id = ?`, [channelId]
  );
  const slowmode = Number(channel?.rate_limit_per_user) || 0;
  if (slowmode <= 0) return;

  const last = await getQuery(
    `SELECT created_at FROM messages
      WHERE channel_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [channelId, userId]
  );
  if (!last) return;

  const elapsedMs = Date.now() - Date.parse(last.created_at);
  const waitMs = slowmode * 1000 - elapsedMs;
  if (waitMs > 0) {
    const seconds = Math.ceil(waitMs / 1000);
    throw new ApiError(`โหมดช้าเปิดอยู่ รออีก ${seconds} วินาที`, {
      status: 429, code: 'SLOWMODE',
      details: { retry_after_seconds: seconds, slowmode_seconds: slowmode }
    });
  }
}

/** Test seam. */
export function resetSpamHistory() {
  recentSends.clear();
}
