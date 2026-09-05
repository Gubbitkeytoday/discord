// ============================================================================
//  Membership screening, welcome screen and onboarding.
//
//  Three Discord features that share one moment: a person has just joined.
//
//  * Screening  — the server's rules; a member is `pending` (can look, cannot
//                 talk — enforced in resolvePermissions) until they accept.
//  * Welcome    — a short description plus up to five highlighted channels.
//  * Onboarding — prompts ("What are you here for?") whose options grant
//                 channels (sidebar picks) and roles.
//
//  Staff edit all of it under MANAGE_GUILD. Members read the bundle with
//  GET /api/servers/:id/onboarding and submit once with PUT .../complete,
//  which records answers, grants roles, lifts `pending` and returns the
//  channels the member chose so the client can highlight them.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { assertPermission, getServerDetail } from './guilds.js';

export const ONBOARDING_LIMITS = Object.freeze({
  rules: 10, ruleLength: 300, welcomeDescription: 140, welcomeChannels: 5,
  prompts: 7, promptTitle: 100, options: 12, optionTitle: 50, optionDescription: 100
});

const parseJson = (text, fallback) => { try { return JSON.parse(text ?? '') ?? fallback; } catch { return fallback; } };

async function getServer(serverId) {
  const server = await getQuery(`SELECT * FROM servers WHERE id = ? AND deleted_at IS NULL`, [serverId]);
  if (!server) throw ApiError.notFound('Server');
  return server;
}

async function assertManage(serverId, userId) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function loadPrompts(serverId) {
  const prompts = await allQuery(
    `SELECT * FROM onboarding_prompts WHERE server_id = ? ORDER BY position ASC`, [serverId]
  );
  if (prompts.length === 0) return [];
  const options = await allQuery(
    `SELECT * FROM onboarding_options WHERE prompt_id IN (${prompts.map(() => '?').join(',')}) ORDER BY position ASC`,
    prompts.map((p) => p.id)
  );
  return prompts.map((p) => ({
    id: p.id, title: p.title, single_select: Boolean(p.single_select), required: Boolean(p.required), position: p.position,
    options: options.filter((o) => o.prompt_id === p.id).map((o) => ({
      id: o.id, title: o.title, description: o.description ?? null, emoji: o.emoji ?? null,
      channel_ids: parseJson(o.channel_ids, []), role_ids: parseJson(o.role_ids, []), position: o.position
    }))
  }));
}

/** The whole bundle a newcomer (or the settings UI) needs. */
export async function getOnboarding(serverId, viewerId = null) {
  const server = await getServer(serverId);
  const welcome = await allQuery(
    `SELECT wc.channel_id, wc.description, wc.emoji, wc.position, c.name, c.type
       FROM welcome_channels wc JOIN channels c ON c.id = wc.channel_id
      WHERE wc.server_id = ? AND c.deleted_at IS NULL ORDER BY wc.position ASC`, [serverId]
  );
  const prompts = await loadPrompts(serverId);
  let me = null;
  if (viewerId) {
    const member = await getQuery(
      `SELECT pending FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`, [serverId, viewerId]
    );
    const record = await getQuery(
      `SELECT * FROM member_onboarding WHERE server_id = ? AND user_id = ?`, [serverId, viewerId]
    );
    me = {
      pending: Boolean(member?.pending),
      rules_accepted_at: record?.rules_accepted_at ?? null,
      completed_at: record?.completed_at ?? null,
      answers: parseJson(record?.answers, {})
    };
  }
  return {
    server_id: serverId,
    screening: { enabled: Boolean(server.screening_enabled), rules: parseJson(server.screening_rules, []) },
    welcome: {
      enabled: Boolean(server.welcome_enabled),
      description: server.welcome_description ?? '',
      channels: welcome.map((w) => ({
        channel_id: w.channel_id, name: w.name, type: w.type, description: w.description, emoji: w.emoji ?? null
      }))
    },
    prompts,
    me
  };
}

// ---------------------------------------------------------------------------
// Write (staff)
// ---------------------------------------------------------------------------

export async function updateScreening({ serverId, userId, enabled, rules }) {
  await getServer(serverId); await assertManage(serverId, userId);
  const sets = []; const params = [];
  if (enabled !== undefined) { sets.push('screening_enabled = ?'); params.push(enabled ? 1 : 0); }
  if (rules !== undefined) {
    if (!Array.isArray(rules) || rules.length > ONBOARDING_LIMITS.rules) {
      throw new ApiError(`Up to ${ONBOARDING_LIMITS.rules} rules`, { code: 'RULES_INVALID' });
    }
    const clean = rules.map((r) => String(r ?? '').trim()).filter(Boolean);
    if (clean.some((r) => r.length > ONBOARDING_LIMITS.ruleLength)) {
      throw new ApiError(`A rule may be at most ${ONBOARDING_LIMITS.ruleLength} characters`, { code: 'RULES_INVALID' });
    }
    sets.push('screening_rules = ?'); params.push(JSON.stringify(clean));
  }
  // Screening without any rule is meaningless; refuse the combination.
  if (sets.length) await runQuery(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, [...params, serverId]);
  const after = await getServer(serverId);
  if (after.screening_enabled && parseJson(after.screening_rules, []).length === 0) {
    await runQuery(`UPDATE servers SET screening_enabled = 0 WHERE id = ?`, [serverId]);
    throw new ApiError('Add at least one rule before enabling screening', { code: 'RULES_REQUIRED' });
  }
  return getOnboarding(serverId, userId);
}

export async function updateWelcome({ serverId, userId, enabled, description, channels }) {
  await getServer(serverId); await assertManage(serverId, userId);
  await transaction(async () => {
    const sets = []; const params = [];
    if (enabled !== undefined) { sets.push('welcome_enabled = ?'); params.push(enabled ? 1 : 0); }
    if (description !== undefined) {
      const clean = String(description ?? '').trim();
      if (clean.length > ONBOARDING_LIMITS.welcomeDescription) {
        throw new ApiError(`Description may be at most ${ONBOARDING_LIMITS.welcomeDescription} characters`, { code: 'WELCOME_INVALID' });
      }
      sets.push('welcome_description = ?'); params.push(clean || null);
    }
    if (sets.length) await runQuery(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, [...params, serverId]);

    if (channels !== undefined) {
      if (!Array.isArray(channels) || channels.length > ONBOARDING_LIMITS.welcomeChannels) {
        throw new ApiError(`Up to ${ONBOARDING_LIMITS.welcomeChannels} welcome channels`, { code: 'WELCOME_INVALID' });
      }
      await runQuery(`DELETE FROM welcome_channels WHERE server_id = ?`, [serverId]);
      let position = 0;
      for (const entry of channels) {
        const channel = await getQuery(
          `SELECT id FROM channels WHERE id = ? AND server_id = ? AND type != 'category' AND deleted_at IS NULL`,
          [entry?.channel_id, serverId]
        );
        if (!channel) throw new ApiError('Unknown channel in welcome screen', { code: 'WELCOME_INVALID' });
        const desc = String(entry.description ?? '').trim().slice(0, 100);
        if (!desc) throw new ApiError('Each welcome channel needs a description', { code: 'WELCOME_INVALID' });
        await runQuery(
          `INSERT INTO welcome_channels (server_id, channel_id, description, emoji, position) VALUES (?, ?, ?, ?, ?)`,
          [serverId, channel.id, desc, entry.emoji ? String(entry.emoji).slice(0, 64) : null, position++]
        );
      }
    }
  });
  return getOnboarding(serverId, userId);
}

/**
 * Replace the whole prompt set. Prompts are small and edited as a unit in the
 * settings UI, so whole-set replacement (the same idempotent pattern as poll
 * votes) is simpler and safer than per-row endpoints.
 */
export async function replacePrompts({ serverId, userId, prompts }) {
  await getServer(serverId); await assertManage(serverId, userId);
  if (!Array.isArray(prompts) || prompts.length > ONBOARDING_LIMITS.prompts) {
    throw new ApiError(`Up to ${ONBOARDING_LIMITS.prompts} prompts`, { code: 'PROMPTS_INVALID' });
  }
  const roles = new Set((await allQuery(`SELECT id FROM roles WHERE server_id = ? AND id != ?`, [serverId, serverId])).map((r) => r.id));
  const channels = new Set((await allQuery(
    `SELECT id FROM channels WHERE server_id = ? AND type NOT IN ('category','thread') AND deleted_at IS NULL`, [serverId]
  )).map((c) => c.id));

  await transaction(async () => {
    await runQuery(`DELETE FROM onboarding_prompts WHERE server_id = ?`, [serverId]);   // cascades options
    let pPos = 0;
    for (const prompt of prompts) {
      const title = String(prompt?.title ?? '').trim();
      if (!title || title.length > ONBOARDING_LIMITS.promptTitle) throw new ApiError('Prompt title invalid', { code: 'PROMPTS_INVALID' });
      const options = Array.isArray(prompt.options) ? prompt.options : [];
      if (options.length === 0 || options.length > ONBOARDING_LIMITS.options) {
        throw new ApiError(`Each prompt needs 1–${ONBOARDING_LIMITS.options} options`, { code: 'PROMPTS_INVALID' });
      }
      const promptId = prompt.id && /^[0-9]+$/.test(String(prompt.id)) ? String(prompt.id) : generateId();
      await runQuery(
        `INSERT INTO onboarding_prompts (id, server_id, title, single_select, required, position) VALUES (?, ?, ?, ?, ?, ?)`,
        [promptId, serverId, title, prompt.single_select ? 1 : 0, prompt.required ? 1 : 0, pPos++]
      );
      let oPos = 0;
      for (const option of options) {
        const oTitle = String(option?.title ?? '').trim();
        if (!oTitle || oTitle.length > ONBOARDING_LIMITS.optionTitle) throw new ApiError('Option title invalid', { code: 'PROMPTS_INVALID' });
        const channelIds = [...new Set((Array.isArray(option.channel_ids) ? option.channel_ids : []).map(String))];
        const roleIds = [...new Set((Array.isArray(option.role_ids) ? option.role_ids : []).map(String))];
        if (channelIds.some((id) => !channels.has(id))) throw new ApiError('Option references an unknown channel', { code: 'PROMPTS_INVALID' });
        if (roleIds.some((id) => !roles.has(id))) throw new ApiError('Option references an unknown role', { code: 'PROMPTS_INVALID' });
        await runQuery(
          `INSERT INTO onboarding_options (id, prompt_id, title, description, emoji, channel_ids, role_ids, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [option.id && /^[0-9]+$/.test(String(option.id)) ? String(option.id) : generateId(), promptId, oTitle,
           option.description ? String(option.description).trim().slice(0, ONBOARDING_LIMITS.optionDescription) : null,
           option.emoji ? String(option.emoji).slice(0, 64) : null,
           JSON.stringify(channelIds), JSON.stringify(roleIds), oPos++]
        );
      }
    }
  });
  return getOnboarding(serverId, userId);
}

// ---------------------------------------------------------------------------
// Member: complete
// ---------------------------------------------------------------------------

/**
 * A member accepts the rules and answers the prompts. Validates that every
 * required prompt is answered, single-select prompts have one answer, and
 * every option id belongs to its prompt. Grants roles, lifts `pending`.
 * Idempotent: resubmitting replaces the answers (roles are re-derived).
 */
export async function complete({ serverId, userId, acceptRules = false, answers = {} }) {
  const server = await getServer(serverId);
  const member = await getQuery(
    `SELECT pending FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`, [serverId, userId]
  );
  if (!member) throw ApiError.forbidden('Not a member of this server');

  const screening = Boolean(server.screening_enabled) && parseJson(server.screening_rules, []).length > 0;
  if (screening && !acceptRules) {
    throw new ApiError('You must accept the server rules', { code: 'RULES_NOT_ACCEPTED' });
  }

  const prompts = await loadPrompts(serverId);
  const chosen = new Map();   // promptId -> [optionId]
  for (const prompt of prompts) {
    const raw = answers?.[prompt.id];
    const ids = [...new Set((Array.isArray(raw) ? raw : raw ? [raw] : []).map(String))];
    const valid = new Set(prompt.options.map((o) => o.id));
    if (ids.some((id) => !valid.has(id))) throw new ApiError('Unknown option', { code: 'ANSWER_INVALID' });
    if (prompt.required && ids.length === 0) {
      throw new ApiError(`"${prompt.title}" needs an answer`, { code: 'ANSWER_REQUIRED', details: { prompt_id: prompt.id } });
    }
    if (prompt.single_select && ids.length > 1) throw new ApiError('Pick one option', { code: 'ANSWER_INVALID' });
    chosen.set(prompt.id, ids);
  }

  // Derive grants from the chosen options.
  const grantRoles = new Set(); const pickChannels = new Set();
  const allOptionRoles = new Set();
  for (const prompt of prompts) {
    for (const option of prompt.options) {
      option.role_ids.forEach((id) => allOptionRoles.add(id));
      if (chosen.get(prompt.id)?.includes(option.id)) {
        option.role_ids.forEach((id) => grantRoles.add(id));
        option.channel_ids.forEach((id) => pickChannels.add(id));
      }
    }
  }

  const now = new Date().toISOString();
  await transaction(async () => {
    await runQuery(
      `INSERT INTO member_onboarding (server_id, user_id, rules_accepted_at, completed_at, answers)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(server_id, user_id) DO UPDATE SET
         rules_accepted_at = COALESCE(member_onboarding.rules_accepted_at, excluded.rules_accepted_at),
         completed_at = excluded.completed_at, answers = excluded.answers`,
      [serverId, userId, acceptRules ? now : null, now, JSON.stringify(Object.fromEntries(chosen))]
    );
    // Roles offered by onboarding are re-derived: drop ones no longer chosen,
    // add the chosen. Roles granted by staff outside onboarding are untouched.
    for (const roleId of allOptionRoles) {
      if (!grantRoles.has(roleId)) {
        await runQuery(`DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?`, [serverId, userId, roleId]);
      }
    }
    for (const roleId of grantRoles) {
      await runQuery(`INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)`, [serverId, userId, roleId]);
    }
    await runQuery(`UPDATE server_members SET pending = 0 WHERE server_id = ? AND user_id = ?`, [serverId, userId]);
  });

  const detail = await getServerDetail(serverId, userId);
  return { ...detail, picked_channel_ids: [...pickChannels], granted_role_ids: [...grantRoles] };
}
