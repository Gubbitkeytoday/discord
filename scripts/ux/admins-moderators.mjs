#!/usr/bin/env node
// ============================================================================
//  UX persona panel — "admins-moderators" regression probe.
//
//  Re-checks the moderator-facing findings in docs/ux-personas/admins-moderators.md
//  against a running server (API-level, so it is fast and deterministic), then
//  takes a couple of screenshots of the admin surfaces.
//
//  Boot the app first (see scripts/e2e/run.mjs for the env), e.g.:
//    PORT=7040 SERVE_STATIC=1 ALLOW_DEV_IDENTITY=0 DB_PATH=/tmp/x/db.db \
//    STORAGE_ROOT=/tmp/x/up RATE_LIMIT_REGISTER_PER_HOUR=200 node server.js
//  Then:  node scripts/ux/admins-moderators.mjs  [UX_BASE=http://localhost:7040]
//
//  Each check prints PASS (fixed) or FAIL (issue still present).
// ============================================================================
import fs from 'node:fs';

const B = process.env.UX_BASE || 'http://localhost:7040';
const PW = 'correct-horse-battery-9';
const RUN = Math.random().toString(36).slice(2, 6);
const SHOTS = process.env.UX_SHOTS
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';

async function reg(u) {
  const r = await fetch(`${B}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: PW })
  });
  const cookie = r.headers.get('set-cookie')?.split(';')[0];
  return { cookie, ...(await r.json()) };
}
async function api(ck, p, m = 'GET', b) {
  const r = await fetch(B + p, {
    method: m, headers: { 'content-type': 'application/json', cookie: ck },
    body: b ? JSON.stringify(b) : undefined
  });
  const t = await r.text();
  try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, t }; }
}
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
};

const owner = await reg(`nat_${RUN}`);
const server = await api(owner.cookie, '/api/servers', 'POST', { name: `TH Gamers ${RUN}` });

// 1. Thai channel names keep their vowel/tone marks (S2-1)
const ch = await api(owner.cookie, '/api/channels', 'POST', { server_id: server.id, name: 'ข่าวสาร อัปเดต', category: 'GAMES' });
check('Thai channel name keeps combining marks', ch.name === 'ข่าวสาร-อัปเดต', `got "${ch.name}"`);

// 2. AutoMod keyword filter vs. trivial Thai evasions (S2-4)
await api(owner.cookie, `/api/servers/${server.id}/automod`, 'POST', {
  name: 'bad words', trigger_type: 'keyword', trigger_metadata: { keywords: ['ควย'] }, actions: ['block']
});
const inv = await api(owner.cookie, `/api/servers/${server.id}/invites`, 'POST', { maxAge: 0 });
const detail = await api(owner.cookie, `/api/servers/${server.id}`);
const general = detail.channels.find((c) => c.name === 'general');
const raider = await reg(`raid_${RUN}`);
await api(raider.cookie, `/api/invites/${inv.code}/accept`, 'POST');
for (const [label, text] of [['zero-width space', 'ค​วย'], ['spaced letters', 'ค ว ย']]) {
  const r = await api(raider.cookie, '/api/messages', 'POST', { channel_id: general.id, content: text });
  check(`AutoMod blocks keyword evasion (${label})`, r.status === 403, `HTTP ${r.status}`);
}

// 3. Manual lockdown really blocks joins even with raid protection off (S1-1)
await api(owner.cookie, `/api/servers/${server.id}/raid/lockdown`, 'POST', { reason: 'probe' });
const late = await reg(`late_${RUN}`);
const j = await api(late.cookie, `/api/invites/${inv.code}/accept`, 'POST');
check('Manual lockdown refuses new joins', j.status === 403, `HTTP ${j.status}`);
await api(owner.cookie, `/api/servers/${server.id}/raid/lockdown`, 'DELETE');

// 4. Ban can wipe recent messages — backend supports it; UI must expose it (S2-5)
const src = fs.readFileSync(new URL('../../src/components/MemberContextMenu.jsx', import.meta.url), 'utf8')
  + fs.readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
check('Ban UI offers "delete message history"', !/deleteMessageSeconds:\s*0\b/.test(src), 'App.jsx hard-codes deleteMessageSeconds: 0');

// 5. Audit log names the target of a ban (S2-7)
await api(owner.cookie, `/api/servers/${server.id}/bans/${raider.user.id}`, 'POST', { reason: 'probe' });
const audit = await api(owner.cookie, `/api/servers/${server.id}/audit-log?limit=5`);
const entries = Array.isArray(audit) ? audit : Object.values(audit).filter((v) => v && typeof v === 'object');
const auditUi = fs.readFileSync(new URL('../../src/components/ServerSettingsModal.jsx', import.meta.url), 'utf8');
check('Audit log UI renders the target user', /target_(display_name|name|user)/.test(auditUi), `${entries.length} entries; AuditTab shows actor only`);

// 6. Screenshots of admin surfaces (optional; needs playwright-core)
try {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'th-TH' });
  const p = await ctx.newPage();
  await p.goto(B);
  await p.locator('form input').first().fill(`nat_${RUN}`);
  await p.locator('form input[type=password]').fill(PW);
  await p.locator('form button[type=submit]').click();
  await p.getByRole('navigation').first().waitFor();
  await p.getByRole('button', { name: `TH Gamers ${RUN}` }).first().click();
  await p.locator('button', { hasText: `TH Gamers ${RUN}` }).first().click();
  await p.getByRole('menuitem').nth(2).click();
  await p.waitForTimeout(600);
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: `${SHOTS}/persona-admins-moderators-probe-settings.png` });
  await browser.close();
  console.log('screenshot saved');
} catch (e) { console.log('(screenshots skipped:', e.message.split('\n')[0], ')'); }

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} fixed`);
process.exit(failed ? 1 : 0);
