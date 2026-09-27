// ============================================================================
//  AutoMod — rule evaluation on the message-send path, plus slowmode and
//  timeout enforcement.
//
//  Everything here runs before a message is persisted, so a blocked message
//  never exists. Rules are per-guild rows in automod_rules.
// ============================================================================

import { RE2JS } from 're2js';

import { runQuery, getQuery, allQuery } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { has, isActiveTimeout } from '../lib/permissions.js';
import { findKeyword, baseNormalize } from './admin/textNormalize.js';
import { expandKeywords, PRESET_IDS } from './admin/automodPresets.js';
import { postModAlert, nameOf } from './admin/modAlerts.js';

const LINK = /https?:\/\/[^\s<]+/gi;
const MENTION = /<@[!&]?[\w-]+>/g;
// @everyone / @here ping the whole server; Discord counts them as mentions.
const MASS_MENTION = /@(everyone|here)\b/g;

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

// Regex rules run on RE2JS, a linear-time engine (the RE2 semantics Discord's
// own AutoMod uses via Rust's regex crate): no backtracking, so no pattern —
// however it is written — can stall the message path (ReDoS). The flip side
// is RE2 syntax: no lookaround and no backreferences; such a pattern is
// refused as invalid when the rule is saved.
const regexCache = new Map();   // source -> compiled | null

function safeRegex(source) {
  if (typeof source !== 'string' || !source || source.length > 200) return null;
  if (regexCache.has(source)) return regexCache.get(source);
  let compiled = null;
  // Nested quantifiers are refused anyway: harmless under RE2, but almost
  // always a mistake, and the clear error helps the author.
  if (!/(\([^)]*[+*]\)[+*])|(\[[^\]]*\][+*][+*])/.test(source)) {
    try { compiled = RE2JS.compile(source, RE2JS.CASE_INSENSITIVE); } catch { compiled = null; }
  }
  if (regexCache.size >= 500) regexCache.delete(regexCache.keys().next().value);
  regexCache.set(source, compiled);
  return compiled;
}

export async function listRules(serverId) {
  const rows = await allQuery(
    `SELECT * FROM automod_rules WHERE server_id = ? ORDER BY created_at DESC`, [serverId]
  );
  return rows.map(inflate);
}

// Rules as enforcement sees them, cached per guild: evaluate() runs on every
// message, and the rule set changes rarely. Every write below invalidates its
// guild; the TTL bounds staleness for writes made by another process.
const RULE_CACHE_TTL_MS = 15_000;
const ruleCache = new Map();   // serverId -> { rules, at }

async function rulesForEnforcement(serverId) {
  const hit = ruleCache.get(serverId);
  if (hit && Date.now() - hit.at < RULE_CACHE_TTL_MS) return hit.rules;
  const rules = await listRules(serverId);
  ruleCache.set(serverId, { rules, at: Date.now() });
  if (ruleCache.size > 5000) ruleCache.delete(ruleCache.keys().next().value);
  return rules;
}

export function invalidateRuleCache(serverId = null) {
  if (serverId) ruleCache.delete(serverId);
  else ruleCache.clear();
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

const cleanList = (list, max, len) => (Array.isArray(list) ? list : [])
  .map((v) => String(v ?? '').trim().slice(0, len)).filter(Boolean).slice(0, max);

/**
 * Validate and normalise a rule's trigger metadata. A rule that can never
 * match (a keyword rule with no words, a regex rule with no pattern) is
 * refused rather than saved as a silent no-op.
 */
async function cleanMetadata(serverId, triggerType, meta = {}, actions = []) {
  const out = { ...(meta && typeof meta === 'object' ? meta : {}) };
  if (triggerType === 'keyword') {
    out.keywords = cleanList(out.keywords, 1000, 60);
    out.presets = cleanList(out.presets, PRESET_IDS.length, 40).filter((id) => PRESET_IDS.includes(id));
    out.allow_list = cleanList(out.allow_list, 100, 60);
    if (out.keywords.length === 0 && out.presets.length === 0) {
      throw new ApiError('Add at least one word or choose a word list', { code: 'EMPTY_RULE' });
    }
  }
  if (triggerType === 'regex' && !safeRegex(out.pattern)) {
    throw new ApiError('That regex is invalid or unsafe', { code: 'INVALID_REGEX' });
  }
  if (triggerType === 'link') {
    out.allowed_domains = cleanList(out.allowed_domains, 100, 253)
      .map((d) => d.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  }
  if (out.alert_channel_id) {
    const channel = await getQuery(
      `SELECT id FROM channels WHERE id = ? AND server_id = ? AND deleted_at IS NULL AND type IN ('text', 'announcement')`,
      [String(out.alert_channel_id), serverId]
    );
    if (!channel) throw new ApiError('The alert channel must be a text channel of this server', { code: 'INVALID_ALERT_CHANNEL' });
  } else {
    delete out.alert_channel_id;
  }
  if (actions.includes('timeout')) {
    const seconds = Number(out.timeout_seconds) || 300;
    out.timeout_seconds = Math.max(10, Math.min(28 * 24 * 3600, Math.round(seconds)));
  }
  return out;
}

export async function createRule({ serverId, actorId, rule }) {
  if (!TRIGGERS.includes(rule?.trigger_type)) {
    throw new ApiError(`trigger_type must be one of ${TRIGGERS.join(', ')}`, { code: 'INVALID_TRIGGER' });
  }
  const actions = (rule.actions ?? ['block']).filter((a) => ACTIONS.includes(a));
  if (actions.length === 0) {
    throw new ApiError(`actions must include at least one of ${ACTIONS.join(', ')}`, { code: 'INVALID_ACTION' });
  }
  if (!String(rule.name ?? '').trim()) {
    throw new ApiError('A rule needs a name', { code: 'INVALID_NAME' });
  }
  rule = { ...rule, trigger_metadata: await cleanMetadata(serverId, rule.trigger_type, rule.trigger_metadata, actions) };

  const id = generateId();
  await runQuery(
    `INSERT INTO automod_rules (id, server_id, name, event_type, trigger_type,
                                trigger_metadata, actions, enabled,
                                exempt_roles, exempt_channels, creator_id)
     VALUES (?, ?, ?, 'message_send', ?, ?, ?, ?, ?, ?, ?)`,
    [id, serverId, String(rule.name).trim().slice(0, 100), rule.trigger_type,
     JSON.stringify(rule.trigger_metadata ?? {}), JSON.stringify(actions),
     rule.enabled === false ? 0 : 1,
     JSON.stringify(rule.exempt_roles ?? []), JSON.stringify(rule.exempt_channels ?? []),
     actorId]
  );
  invalidateRuleCache(serverId);
  return inflate(await getQuery(`SELECT * FROM automod_rules WHERE id = ?`, [id]));
}

export async function updateRule({ serverId, ruleId, patch }) {
  const existing = await getQuery(
    `SELECT * FROM automod_rules WHERE id = ? AND server_id = ?`, [ruleId, serverId]
  );
  if (!existing) throw ApiError.notFound('Rule');

  if (patch.trigger_type !== undefined && !TRIGGERS.includes(patch.trigger_type)) {
    throw new ApiError(`trigger_type must be one of ${TRIGGERS.join(', ')}`, { code: 'INVALID_TRIGGER' });
  }
  let actions;
  if (patch.actions !== undefined) {
    actions = (Array.isArray(patch.actions) ? patch.actions : []).filter((a) => ACTIONS.includes(a));
    if (actions.length === 0) {
      throw new ApiError(`actions must include at least one of ${ACTIONS.join(', ')}`, { code: 'INVALID_ACTION' });
    }
  }
  if (patch.name !== undefined && !String(patch.name ?? '').trim()) {
    throw new ApiError('A rule needs a name', { code: 'INVALID_NAME' });
  }
  // Metadata is validated against the rule as it will be after the patch.
  let metadata;
  if (patch.trigger_metadata !== undefined || patch.trigger_type !== undefined || actions !== undefined) {
    metadata = await cleanMetadata(
      serverId,
      patch.trigger_type ?? existing.trigger_type,
      patch.trigger_metadata ?? safeJson(existing.trigger_metadata, {}),
      actions ?? safeJson(existing.actions, [])
    );
  }

  const fields = {
    name: patch.name === undefined ? undefined : String(patch.name).trim().slice(0, 100),
    trigger_type: patch.trigger_type,
    trigger_metadata: metadata ? JSON.stringify(metadata) : undefined,
    actions: actions ? JSON.stringify(actions) : undefined,
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
  invalidateRuleCache(serverId);
  return inflate(await getQuery(`SELECT * FROM automod_rules WHERE id = ?`, [ruleId]));
}

export async function deleteRule({ serverId, ruleId }) {
  await runQuery(`DELETE FROM automod_rules WHERE id = ? AND server_id = ?`, [ruleId, serverId]);
  invalidateRuleCache(serverId);
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

  const rules = await rulesForEnforcement(serverId);
  if (rules.length === 0) return { blocked: false, actions: [] };

  const history = rememberSend(channelId, userId, content);
  const lowered = baseNormalize(content);

  // Every rule is evaluated: an alert-only rule that matches first must not
  // hide a blocking rule further down the list.
  const hits = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.exempt_channels.includes(channelId)) continue;
    if (rule.exempt_roles.some((roleId) => memberRoleIds.includes(roleId))) continue;

    const hit = matches(rule, { content: String(content ?? ''), lowered, history });
    if (hit) hits.push({ rule, reason: hit });
  }
  if (hits.length === 0) return { blocked: false, actions: [] };

  const blocking = hits.find((h) => h.rule.actions.includes('block')) ?? null;
  const timeoutHit = hits.find((h) => h.rule.actions.includes('timeout'));
  if (timeoutHit) {
    const seconds = Number(timeoutHit.rule.trigger_metadata?.timeout_seconds) || 300;
    await runQuery(
      `UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?`,
      [new Date(Date.now() + seconds * 1000).toISOString(), serverId, userId]
    );
  }

  for (const h of hits.filter((x) => x.rule.actions.includes('alert'))) {
    await alertModerators({
      serverId, channelId, userId, content, rule: h.rule, reason: h.reason,
      blocked: Boolean(blocking), timedOut: Boolean(timeoutHit)
    });
    // A blocked message is logged as AUTOMOD_BLOCK by the caller; an alert on
    // a message that still goes through gets its own entry.
    if (!blocking) {
      await logHit({ serverId, userId, channelId, rule: h.rule, reason: h.reason, content, actionType: 'AUTOMOD_ALERT' });
    }
  }

  const primary = blocking ?? hits[0];
  return {
    blocked: Boolean(blocking),
    rule: primary.rule,
    reason: primary.reason,
    actions: [...new Set(hits.flatMap((h) => h.rule.actions))]
  };
}

/** Post the "AutoMod caught something" alert into the rule's alert channel. */
async function alertModerators({ serverId, channelId, userId, content, rule, reason, blocked, timedOut }) {
  const who = await nameOf(userId);
  await postModAlert({
    serverId,
    channelId: rule.trigger_metadata?.alert_channel_id ?? null,
    title: `AutoMod ${blocked ? 'blocked' : 'flagged'} a message from ${who}`,
    description: String(content ?? '').slice(0, 1000),
    color: blocked ? '#ed4245' : '#faa61a',
    fields: [
      { name: 'Rule', value: rule.name, inline: true },
      { name: 'Channel', value: `<#${channelId}>`, inline: true },
      { name: 'Member', value: `${who} (${userId})`, inline: true },
      { name: 'Reason', value: reason },
      timedOut ? { name: 'Action', value: 'Timed out' } : null
    ]
  });
}

function matches(rule, { content, lowered, history }) {
  const meta = rule.trigger_metadata ?? {};

  switch (rule.trigger_type) {
    case 'keyword': {
      const { keywords, allow } = expandKeywords(meta);
      const found = findKeyword(content, keywords, { allowList: allow });
      return found ? `Blocked word: "${found}"` : null;
    }
    case 'regex': {
      const pattern = safeRegex(meta.pattern);
      return pattern?.matcher(String(content ?? '')).find() ? 'Matches a blocked pattern' : null;
    }
    case 'link': {
      const links = content.match(LINK) ?? [];
      if (links.length === 0) return null;
      const allow = (meta.allowed_domains ?? []).map((d) => String(d).toLowerCase());
      if (allow.length === 0) return 'Links are not allowed in this server';
      const bad = links.find((link) => {
        try {
          const host = new URL(link).hostname.toLowerCase();
          return !allow.some((d) => host === d || host.endsWith(`.${d}`));
        } catch { return true; }
      });
      return bad ? `Link not allowed: ${bad}` : null;
    }
    case 'mention_spam': {
      const limit = Number(meta.max_mentions) || 5;
      const count = (content.match(MENTION) ?? []).length + (lowered.match(MASS_MENTION) ?? []).length;
      return count > limit ? `Too many mentions (${count} > ${limit})` : null;
    }
    case 'spam': {
      const limit = Number(meta.max_messages) || 5;
      if (history.length > limit) return `Sending too fast (${history.length} in 10 s)`;
      // Repeating the identical message is spam even under the rate limit.
      const duplicates = history.filter((e) => e.content === content).length;
      return duplicates >= 3 ? 'Repeated the same message' : null;
    }
    default:
      return null;
  }
}

/** Record a blocked message so moderators can see what AutoMod caught. */
export async function logHit({ serverId, userId, channelId, rule, reason, content, actionType = 'AUTOMOD_BLOCK' }) {
  await runQuery(
    `INSERT INTO audit_logs (id, server_id, user_id, action_type, target_type, target_id, changes, reason)
     VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`,
    [generateId(), serverId, userId, actionType, userId,
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
export async function assertCanSpeak({ serverId, channelId, userId, permissions = '0', slowmodeSeconds = undefined }) {
  // An administrator is never silenced by a timeout, matching Discord.
  if (serverId && !has(permissions, 'ADMINISTRATOR')) {
    const member = await getQuery(
      `SELECT timeout_until FROM server_members WHERE server_id = ? AND user_id = ?`,
      [serverId, userId]
    );
    // Parsed, not string-compared: an offset like +07:00 sorts wrong as text.
    if (isActiveTimeout(member?.timeout_until)) {
      throw new ApiError('You are timed out and cannot send messages yet', {
        status: 403, code: 'TIMED_OUT',
        details: { until: member.timeout_until }
      });
    }
  }

  // MANAGE_MESSAGES / MANAGE_CHANNELS bypass slowmode, as on Discord.
  if (has(permissions, 'MANAGE_MESSAGES') || has(permissions, 'MANAGE_CHANNELS')) return;

  // The caller usually has the channel row already.
  const channel = slowmodeSeconds === undefined
    ? await getQuery(`SELECT rate_limit_per_user FROM channels WHERE id = ?`, [channelId])
    : { rate_limit_per_user: slowmodeSeconds };
  const slowmode = Number(channel?.rate_limit_per_user) || 0;
  if (slowmode <= 0) return;

  const last = await getQuery(
    // Deleted messages count too: otherwise send → delete → send walks
    // straight through slowmode.
    `SELECT created_at FROM messages
      WHERE channel_id = ? AND user_id = ?
      ORDER BY id DESC LIMIT 1`,
    [channelId, userId]
  );
  if (!last) return;

  const elapsedMs = Date.now() - Date.parse(last.created_at);
  const waitMs = slowmode * 1000 - elapsedMs;
  if (waitMs > 0) {
    const seconds = Math.ceil(waitMs / 1000);
    throw new ApiError(`Slowmode is on — wait ${seconds} s`, {
      status: 429, code: 'SLOWMODE',
      details: { retry_after_seconds: seconds, slowmode_seconds: slowmode }
    });
  }
}

/** Test seam. */
export function resetSpamHistory() {
  recentSends.clear();
}
