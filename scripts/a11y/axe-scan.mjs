#!/usr/bin/env node
// ============================================================================
//  Runtime accessibility scan: Playwright + axe-core against the real SPA.
//
//  scripts/a11y-audit.mjs is a *static* JSX lint. This script complements it by
//  rendering every major view and modal and letting axe-core inspect the live
//  DOM (computed colours, real accessible names, real ARIA tree), then runs a
//  set of manual-style probes that axe cannot do on its own:
//    keyboard tab order + focus visibility, Escape handling, focus return,
//    landmarks/headings/live regions, WCAG 2.5.8 target size, 1.4.10 reflow at
//    320 CSS px, 1.4.12 text spacing, role-colour contrast, reduced motion,
//    Thai glyph clipping.
//
//  - Boots `node server.js` on a throwaway SQLite DB (port 5850 by default)
//    with SERVE_STATIC=1, so the built dist/ is what gets scanned.
//  - Registers two users through the UI, seeds a server with text / forum /
//    voice channels, a coloured role, messages (incl. Thai), a thread, a forum
//    post, an event and a DM through the API.
//  - Matrix: theme (dark, light) x viewport (desktop 1366x860, mobile 390x844).
//
//  Setup:  npm ci && npm run build
//          npm i --no-save playwright-core @axe-core/playwright axe-core
//  Usage:  node scripts/a11y/axe-scan.mjs [--only=dark-desktop] [--views=a,b]
//                                         [--no-probes] [--probes-only]
//  Env:    A11Y_PORT (5850), A11Y_OUT (json + screenshot dir), CHROMIUM_PATH
//  Output: <A11Y_OUT>/axe-results.json, <A11Y_OUT>/probes.json,
//          <A11Y_OUT>/a11y-<view>-<theme>-<viewport>.png for views with issues.
//  Exit code: 0 always (it is an audit tool, not a gate) unless setup fails.
// ============================================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium; let AxeBuilder;
try {
  ({ chromium } = await import('playwright-core'));
  ({ default: AxeBuilder } = await import('@axe-core/playwright'));
} catch {
  console.error('Missing deps. Run: npm i --no-save playwright-core @axe-core/playwright axe-core');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const PORT = Number(process.env.A11Y_PORT || 5850);
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.A11Y_OUT
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const RUN = Math.random().toString(36).slice(2, 7);
const PASSWORD = 'correct-horse-battery-9';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) {
  console.error('dist/ missing. Run: npm run build');
  process.exit(2);
}

// --- server -----------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-discord-'));
let server; let serverLog = '';
async function bootServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development', PORT: String(PORT), HOST: '127.0.0.1', PUBLIC_URL: BASE,
      CORS_ORIGIN: '', DB_PATH: path.join(tmp, 'a11y.db'), STORAGE_ROOT: path.join(tmp, 'uploads'),
      SERVE_STATIC: '1', ALLOW_DEV_IDENTITY: '0', MAIL_TRANSPORT: 'console',
      LOG_LEVEL: 'warn', LOG_FORMAT: 'pretty'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${serverLog}`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server not healthy:\n${serverLog}`);
}
function stopServer() {
  if (server && server.exitCode === null) server.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('SIGINT', () => { stopServer(); process.exit(130); });

// --- helpers ----------------------------------------------------------------
async function newContext(browser, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, ...opts });
  await context.route((u) => !u.href.startsWith(BASE) && /^https?:/.test(u.href), (r) => r.abort());
  context.setDefaultTimeout(8000);
  return context;
}
const api = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${text.slice(0, 200)}`);
  return json;
}, { method, url, body });

async function register(page, username) {
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel(/Username/).fill(username);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await page.getByRole('navigation', { name: 'Servers' }).waitFor();
}
const composer = (page) => page.locator('textarea[aria-label^="Message"], [role="textbox"][aria-label^="Message"]').first();
const settle = (page, ms = 350) => page.waitForTimeout(ms);
async function closeAll(page) {
  for (let i = 0; i < 3; i += 1) { await page.keyboard.press('Escape').catch(() => {}); await settle(page, 120); }
}

async function setTheme(page, theme) {
  await api(page, 'PATCH', '/api/settings/preferences/appearance', { theme });
  await page.evaluate((theme) => {
    const k = 'antigravity.preferences';
    const v = JSON.parse(localStorage.getItem(k) || '{}');
    v.appearance = { ...(v.appearance || {}), theme };
    localStorage.setItem(k, JSON.stringify(v));
  }, theme);
}

// --- seed -------------------------------------------------------------------
const alice = `alice_${RUN}`;
const bob = `bob_${RUN}`;
const S = {}; // seeded ids

async function seed(a, b) {
  const server = await api(a, 'POST', '/api/servers', { name: `A11y Guild ${RUN}` });
  S.server = server.server?.id ?? server.id;
  const mk = async (name, type) => {
    const c = await api(a, 'POST', '/api/channels', { server_id: S.server, name, type });
    return c.channel?.id ?? c.id;
  };
  S.text = await mk(`general-${RUN}`, 'text');
  S.forum = await mk(`forum-${RUN}`, 'forum');
  S.voice = await mk(`voice-${RUN}`, 'voice');
  const inv = await api(a, 'POST', `/api/servers/${S.server}/invites`, { maxAge: 0 });
  const code = inv.code ?? inv.invite?.code;
  await api(b, 'POST', `/api/invites/${code}/accept`, {});
  // Coloured roles that sit at typical Discord hues (contrast probe uses them).
  const colors = ['#1abc9c', '#e91e63', '#f1c40f', '#3498db', '#992d22', '#11806a', '#206694', '#71368a'];
  S.roles = [];
  for (const [i, color] of colors.entries()) {
    const r = await api(a, 'POST', `/api/servers/${S.server}/roles`, { name: `role-${i}`, color, hoist: i === 0 });
    S.roles.push({ id: r.role?.id ?? r.id, color });
  }
  const me = await api(b, 'GET', '/api/auth/me');
  S.bobId = me.user?.id ?? me.id;
  const meA = await api(a, 'GET', '/api/auth/me');
  S.aliceId = meA.user?.id ?? meA.id;
  await api(a, 'PUT', `/api/servers/${S.server}/members/${S.bobId}/roles/${S.roles[1].id}`).catch(() => {});
  await api(a, 'PUT', `/api/servers/${S.server}/members/${S.aliceId}/roles/${S.roles[2].id}`).catch(() => {});
  const msgs = [
    [a, `hello from alice ${RUN} — **bold** and \`code\``],
    [b, `reply from bob ${RUN} with a link https://example.com`],
    [a, 'ภาษาไทย: สวัสดีครับ ทดสอบการแสดงผลสระบน-ล่าง ปั้น ญี่ปุ่น ฤๅษี ฎีกา ฐาน'],
    [b, `@${alice} ping ${RUN}`],
    [a, '> quoted text\n- list one\n- list two'],
    [b, 'second message from bob for grouping'],
    [a, `searchable needle ${RUN}`]
  ];
  S.messages = [];
  for (const [pg, content] of msgs) {
    const m = await api(pg, 'POST', '/api/messages', { channel_id: S.text, content });
    S.messages.push(m.message?.id ?? m.id);
  }
  const th = await api(a, 'POST', `/api/channels/${S.text}/threads`, { messageId: S.messages[0], name: `thread-${RUN}` });
  S.thread = th.thread?.id ?? th.id ?? th.channel?.id;
  if (S.thread) await api(a, 'POST', '/api/messages', { channel_id: S.thread, content: `inside thread ${RUN}` });
  await api(a, 'POST', `/api/channels/${S.forum}/forum/posts`, { title: `Forum post ${RUN}`, content: 'First forum post body' }).catch((e) => console.warn('forum post:', e.message));
  const starts = new Date(Date.now() + 86_400_000).toISOString();
  await api(a, 'POST', `/api/servers/${S.server}/events`, {
    name: `Game night ${RUN}`, description: 'Weekly event', starts_at: starts,
    entity_type: 'voice', channel_id: S.voice
  }).catch(async () => api(a, 'POST', `/api/servers/${S.server}/events`, {
    name: `Game night ${RUN}`, starts_at: starts, location: 'Online'
  })).catch((e) => console.warn('event:', e.message));
  // DM bob -> alice
  const dm = await api(b, 'POST', '/api/dms', { recipientId: S.aliceId }).catch((e) => { console.warn('dm:', e.message); return null; });
  S.dm = dm?.channel?.id ?? dm?.id ?? null;
  if (S.dm) await api(b, 'POST', '/api/messages', { channel_id: S.dm, content: `dm hi ${RUN}` }).catch(() => {});
}

// --- views ------------------------------------------------------------------
const chanUrl = (id) => `${BASE}/channels/${S.server}/${id}`;
async function openChannel(page, id) {
  await page.goto(chanUrl(id));
  await page.getByRole('navigation', { name: 'Servers' }).waitFor({ state: 'attached' });
  await settle(page, 700);
  // Phones open on the navigation drawer; tap the dimmed conversation to put it away.
  if ((page.viewportSize()?.width ?? 1366) < 768 && await page.getByRole('navigation', { name: 'Servers' }).isVisible()) {
    await page.mouse.click(page.viewportSize().width - 12, Math.round(page.viewportSize().height / 2));
    await settle(page, 400);
  }
}
/** On phones, re-open the navigation drawer (server rail + channel list + user panel). */
async function openDrawer(page) {
  if (await page.getByRole('navigation', { name: 'Servers' }).isVisible()) return;
  await page.getByRole('button', { name: 'Show channels' }).first().click();
  await settle(page, 400);
}
async function openUserSettings(page, tab) {
  await openChannel(page, S.text);
  await openDrawer(page);
  await page.getByRole('button', { name: 'User settings' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'User settings' });
  await dlg.waitFor();
  if (tab) {
    const nav = dlg.getByRole('navigation').first();
    const btn = nav.getByRole('button', { name: tab, exact: true }).or(nav.getByRole('tab', { name: tab, exact: true }));
    if (!(await btn.first().isVisible().catch(() => false))) {
      // Mobile: the settings nav is a list shown first; it may need a "back" step.
      await dlg.getByRole('button', { name: /back/i }).first().click().catch(() => {});
    }
    await btn.first().click();
  }
  await settle(page);
}
async function openServerSettings(page, tab) {
  await openChannel(page, S.text);
  await openDrawer(page);
  await page.getByText(`A11y Guild ${RUN}`).first().click();
  await page.getByRole('menuitem', { name: 'Server settings' }).or(page.getByRole('button', { name: 'Server settings' })).first().click();
  const dlg = page.getByRole('dialog', { name: 'Server settings' });
  await dlg.waitFor();
  if (tab) {
    const btn = dlg.getByRole('button', { name: tab, exact: true }).or(dlg.getByRole('tab', { name: tab, exact: true }));
    if (!(await btn.first().isVisible().catch(() => false))) await dlg.getByRole('button', { name: /back/i }).first().click().catch(() => {});
    await btn.first().click();
  }
  await settle(page);
}
const USER_TABS = ['Profile', 'Account & security', 'Privacy & Safety', 'Activity privacy', 'Appearance', 'Accessibility',
  'Voice & video', 'Notifications', 'Keybinds', 'Text & Images', 'Streamer mode', 'Applications'];
const SERVER_TABS = ['Overview', 'Roles', 'Channel permissions', 'Emoji', 'Stickers', 'Soundboard', 'Webhooks',
  'AutoMod', 'Reports', 'Audit log', 'Bans', 'Onboarding', 'Insights', 'Members', 'Invites'];

const DIALOG = '[role=dialog],[role=alertdialog]';
function buildViews() {
  const v = [];
  v.push({ name: 'login', anon: true, setup: async (p) => { await p.goto(BASE + '/'); await p.getByLabel(/Username/).waitFor(); } });
  v.push({ name: 'register', anon: true, setup: async (p) => { await p.goto(BASE + '/'); await p.getByRole('button', { name: 'Sign up' }).click(); await settle(p); } });
  v.push({ name: 'home-dms', setup: async (p) => {
    await p.goto(BASE + '/channels/@me'); await p.getByRole('navigation', { name: 'Servers' }).waitFor(); await settle(p, 600);
  } });
  v.push({ name: 'dm-chat', setup: async (p) => {
    if (!S.dm) throw new Error('no dm seeded');
    await p.goto(`${BASE}/channels/@me/${S.dm}`); await composer(p).waitFor(); await settle(p, 500);
  } });
  v.push({ name: 'server-chat', setup: async (p) => { await openChannel(p, S.text); await composer(p).waitFor(); } });
  v.push({ name: 'member-list', setup: async (p) => {
    await openChannel(p, S.text);
    if (!(await p.locator('aside[aria-label*="member" i]').isVisible())) await p.getByRole('button', { name: 'Member list' }).first().click();
    await settle(p);
  } });
  v.push({ name: 'thread', setup: async (p) => { await openChannel(p, S.thread); await composer(p).waitFor(); } });
  v.push({ name: 'forum', setup: async (p) => { await openChannel(p, S.forum); await settle(p, 500); } });
  v.push({ name: 'voice-room', setup: async (p) => {
    await openChannel(p, S.text); await openDrawer(p);
    await p.getByText(`voice-${RUN}`).first().click();
    await settle(p, 1500);
  } });
  v.push({ name: 'events', setup: async (p) => {
    await openChannel(p, S.text); await openDrawer(p);
    await p.getByText(`A11y Guild ${RUN}`).first().click();
    await p.getByRole('menuitem', { name: 'Events' }).or(p.getByRole('button', { name: 'Events' })).first().click();
    await settle(p, 500);
  } });
  v.push({ name: 'server-dropdown', setup: async (p) => {
    await openChannel(p, S.text); await openDrawer(p); await p.getByText(`A11y Guild ${RUN}`).first().click(); await settle(p);
  } });
  v.push({ name: 'quick-switcher', setup: async (p) => {
    await openChannel(p, S.text); await p.keyboard.press('Control+k'); await settle(p);
    await p.keyboard.type('gen'); await settle(p);
  } });
  v.push({ name: 'message-context-menu', setup: async (p) => {
    await openChannel(p, S.text);
    await p.locator('[id^="message-"]').filter({ hasText: `hello from alice ${RUN}` }).first().click({ button: 'right' });
    await p.getByRole('menu').first().waitFor(); await settle(p, 200);
  } });
  v.push({ name: 'member-context-menu', setup: async (p) => {
    await openChannel(p, S.text);
    if (!(await p.locator('aside[aria-label*="member" i]').isVisible())) await p.getByRole('button', { name: 'Member list' }).first().click();
    await p.locator('aside[aria-label*="member" i]').getByText(bob).first().click({ button: 'right' });
    await settle(p, 250);
  } });
  v.push({ name: 'emoji-picker', setup: async (p) => {
    await openChannel(p, S.text);
    await p.getByRole('button', { name: /emoji/i }).last().click();
    await settle(p, 400);
  } });
  v.push({ name: 'search-results', setup: async (p) => {
    await openChannel(p, S.text);
    const box = p.getByRole('searchbox', { name: /Search/ }).or(p.getByPlaceholder('Search')).first();
    if (!(await box.isVisible())) await p.getByRole('button', { name: /Search/ }).first().click();
    await box.fill('needle'); await box.press('Enter'); await settle(p, 800);
  } });
  v.push({ name: 'inbox', setup: async (p) => { await openChannel(p, S.text); await p.getByRole('button', { name: 'Inbox' }).first().click(); await settle(p); } });
  v.push({ name: 'pinned', setup: async (p) => { await openChannel(p, S.text); await p.getByRole('button', { name: 'Pinned messages' }).first().click(); await settle(p); } });
  v.push({ name: 'user-profile', setup: async (p) => {
    await openChannel(p, S.text);
    await p.locator('[id^="message-"]').filter({ hasText: `reply from bob ${RUN}` }).getByText(bob).first().click();
    await settle(p, 400);
  } });
  v.push({ name: 'create-server-modal', setup: async (p) => { await openChannel(p, S.text); await openDrawer(p); await p.getByRole('button', { name: 'Add a server' }).click(); await settle(p); } });
  v.push({ name: 'create-channel-modal', setup: async (p) => {
    await openChannel(p, S.text); await openDrawer(p);
    await p.getByRole('button', { name: 'Create text channel' }).or(p.getByTitle('Create text channel')).first().click(); await settle(p);
  } });
  for (const tab of USER_TABS) v.push({ name: `user-settings:${tab}`, scope: DIALOG, setup: (p) => openUserSettings(p, tab) });
  for (const tab of SERVER_TABS) v.push({ name: `server-settings:${tab}`, scope: DIALOG, setup: (p) => openServerSettings(p, tab) });
  // Modals are scanned inside the dialog only, so background findings are not double-counted.
  for (const x of v) if (/quick-switcher|create-server|create-channel|user-profile|events/.test(x.name)) x.scope = DIALOG;
  return v;
}

// --- axe --------------------------------------------------------------------
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
async function runAxe(page, scope) {
  let b = new AxeBuilder({ page }).withTags(TAGS);
  if (scope && await page.locator(scope).count()) b = b.include(scope);
  const r = await b.analyze();
  return r.violations.map((v) => ({
    id: v.id, impact: v.impact, tags: v.tags.filter((t) => /^wcag\d/.test(t)), help: v.help,
    nodes: v.nodes.length,
    samples: v.nodes.slice(0, 4).map((n) => ({ target: n.target.join(' '), summary: (n.failureSummary || '').split('\n').slice(1, 3).join(' ').slice(0, 220), html: n.html.slice(0, 160) }))
  }));
}

async function scanMatrix(browser, views) {
  const combos = [
    { theme: 'dark', vp: 'desktop', viewport: { width: 1366, height: 860 } },
    { theme: 'light', vp: 'desktop', viewport: { width: 1366, height: 860 } },
    { theme: 'dark', vp: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    { theme: 'light', vp: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
  ].filter((c) => !opt('only') || opt('only').split(',').includes(`${c.theme}-${c.vp}`));
  const results = [];
  for (const c of combos) {
    const ctx = await newContext(browser, { viewport: c.viewport, isMobile: !!c.isMobile, hasTouch: !!c.hasTouch, storageState: aliceState });
    const anonCtx = await newContext(browser, { viewport: c.viewport, isMobile: !!c.isMobile, hasTouch: !!c.hasTouch, colorScheme: c.theme });
    const page = await ctx.newPage();
    const anon = await anonCtx.newPage();
    await page.goto(BASE + '/channels/@me');
    await setTheme(page, c.theme);
    for (const view of views) {
      const p = view.anon ? anon : page;
      const key = `${view.name} [${c.theme}/${c.vp}]`;
      try {
        await closeAll(p);
        await view.setup(p);
        if (view.anon && c.theme === 'light') {
          // Login screen reads the stored preference; force it.
          await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
        }
        const violations = await runAxe(p, view.scope);
        const count = violations.reduce((n, v) => n + v.nodes, 0);
        let shot = null;
        if (violations.some((v) => v.impact === 'serious' || v.impact === 'critical')) {
          shot = path.join(OUT, `a11y-${slug(view.name)}-${c.theme}-${c.vp}.png`);
          await p.screenshot({ path: shot }).catch(() => {});
        }
        results.push({ view: view.name, theme: c.theme, viewport: c.vp, ok: true, rules: violations.length, nodes: count, violations, shot });
        console.log(`  ${String(violations.length).padStart(2)} rules / ${String(count).padStart(3)} nodes  ${key}`);
      } catch (err) {
        const shot = path.join(OUT, `a11y-setupfail-${slug(view.name)}-${c.theme}-${c.vp}.png`);
        await p.screenshot({ path: shot }).catch(() => {});
        results.push({ view: view.name, theme: c.theme, viewport: c.vp, ok: false, error: String(err.message).split('\n')[0], shot });
        console.log(`  SETUP FAIL ${key}: ${String(err.message).split('\n')[0]}`);
      }
    }
    await ctx.close(); await anonCtx.close();
  }
  return results;
}

// --- probes (manual-style checks) --------------------------------------------
function lum(hex) {
  const m = hex.replace('#', '').match(/.{2}/g).map((x) => parseInt(x, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return +((x + 0.05) / (y + 0.05)).toFixed(2); };

async function probes(browser) {
  const P = {};
  const ctx = await newContext(browser, { storageState: aliceState });
  const page = await ctx.newPage();
  await page.goto(BASE + '/channels/@me');
  await setTheme(page, 'dark');
  await openChannel(page, S.text);
  await composer(page).waitFor();

  // 1. Landmarks, headings, live regions, skip link, lang.
  P.semantics = await page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    const name = (el) => el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent) || '';
    return {
      lang: document.documentElement.lang,
      title: document.title,
      landmarks: q('main,nav,aside,header,footer,[role=main],[role=navigation],[role=complementary],[role=banner],[role=contentinfo],[role=region],[role=search],form[aria-label]')
        .map((e) => `${e.getAttribute('role') || e.tagName.toLowerCase()}${name(e) ? `"${name(e).trim().slice(0, 40)}"` : ''}`),
      headings: q('h1,h2,h3,h4,h5,h6,[role=heading]').map((h) => `${h.tagName}${h.getAttribute('aria-level') ? h.getAttribute('aria-level') : ''}:${h.textContent.trim().slice(0, 40)}`),
      liveRegions: q('[aria-live],[role=log],[role=status],[role=alert]').map((e) => `${e.getAttribute('role') || ''}[aria-live=${e.getAttribute('aria-live')}] ${e.getAttribute('aria-label') || ''} children=${e.children.length}`),
      skipLink: q('a[href^="#"]').filter((a) => /skip/i.test(a.textContent)).map((a) => a.textContent.trim()),
      messageListRole: (() => {
        const m = document.querySelector('[id^="message-"]');
        const list = m?.closest('[role=log],[role=list],[role=feed],ol,ul');
        return list ? `${list.tagName} role=${list.getAttribute('role')} aria-live=${list.getAttribute('aria-live')} label=${list.getAttribute('aria-label')}` : 'none';
      })(),
      messageItem: (() => {
        const m = document.querySelector('[id^="message-"]');
        return m ? `${m.tagName} role=${m.getAttribute('role')} tabindex=${m.getAttribute('tabindex')} aria-labelledby=${m.getAttribute('aria-labelledby')} aria-setsize=${m.getAttribute('aria-setsize')}` : 'none';
      })(),
      composer: (() => {
        const c = document.querySelector('textarea[aria-label^="Message"], [role="textbox"][aria-label^="Message"]');
        return c ? `${c.tagName} aria-label="${c.getAttribute('aria-label')}" aria-describedby=${c.getAttribute('aria-describedby')} aria-autocomplete=${c.getAttribute('aria-autocomplete')}` : 'none';
      })(),
      channelTree: (() => {
        const t = document.querySelector('[role=tree],[role=list][aria-label*="hannel" i],nav[aria-label*="hannel" i]');
        return t ? `${t.tagName} role=${t.getAttribute('role')} label=${t.getAttribute('aria-label')}` : 'none';
      })(),
      serverRail: (() => {
        const t = document.querySelector('nav[aria-label="Servers"]');
        const items = t ? [...t.querySelectorAll('[role=treeitem],[role=listitem],li,button')].length : 0;
        return t ? `nav role=${t.getAttribute('role')} tree=${!!t.querySelector('[role=tree]')} items=${items}` : 'none';
      })()
    };
  });

  // 2. Live announcement of a new incoming message + typing (bob posts).
  const bctx = await newContext(browser, { storageState: bobState });
  const bpage = await bctx.newPage();
  await bpage.goto(chanUrl(S.text));
  await composer(bpage).waitFor();
  await page.evaluate(() => {
    window.__live = [];
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        const live = el?.closest('[aria-live]:not([aria-live=off]),[role=log],[role=status],[role=alert]');
        if (live) window.__live.push(`${live.getAttribute('role') || ''}/${live.getAttribute('aria-live')}: ${(m.addedNodes[0]?.textContent || m.target.textContent || '').trim().slice(0, 80)}`);
      }
    });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  const cb = composer(bpage);
  await cb.click(); await cb.pressSequentially('typing', { delay: 40 });
  await settle(page, 1200);
  await cb.fill(`live region check ${RUN}`); await cb.press('Enter');
  await page.locator('[id^="message-"]').filter({ hasText: `live region check ${RUN}` }).first().waitFor().catch(() => {});
  await settle(page, 800);
  P.liveAnnouncements = await page.evaluate(() => [...new Set(window.__live)].slice(0, 30));
  await bctx.close();

  // 3. Keyboard walkthrough: first 60 tab stops from page top.
  await openChannel(page, S.text);
  await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  const stops = [];
  for (let i = 0; i < 70; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return { name: 'BODY' };
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const ring = /rgb|#/.test(cs.boxShadow) && cs.boxShadow !== 'none';
      return {
        tag: e.tagName, role: e.getAttribute('role'),
        name: (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || e.getAttribute('placeholder') || '').trim().slice(0, 40),
        focusVisible: outline || ring, w: Math.round(r.width), h: Math.round(r.height),
        region: e.closest('nav,aside,main,header,[role=dialog]')?.getAttribute('aria-label') || e.closest('nav,aside,main,header')?.tagName || ''
      };
    }));
  }
  P.tabOrder = stops;
  P.tabNoFocusRing = stops.filter((s) => s.name !== 'BODY' && !s.focusVisible).map((s) => `${s.tag}:${s.name}`);
  // Tab stops until composer
  P.tabStopsToComposer = stops.findIndex((s) => /^Message/.test(s.name)) + 1;

  // 4. Arrow-key navigation between messages (Discord: focus message list then Up/Down).
  await composer(page).click();
  await page.keyboard.press('Shift+Tab');
  const before = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  await page.keyboard.press('ArrowUp');
  const after = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  P.messageArrowNav = { before, after, messagesFocusable: await page.locator('[id^="message-"][tabindex]').count() };
  // Up arrow in empty composer = edit last own message (Discord).
  await composer(page).click();
  await composer(page).fill('');
  await page.keyboard.press('ArrowUp');
  await settle(page, 300);
  P.upArrowEditsLast = await page.getByRole('textbox', { name: 'Edit message' }).or(page.locator('textarea[aria-label="Edit message"]')).count() > 0;
  await closeAll(page);

  // 5. Dialog behaviour: focus moves in, trap, Escape, focus returns.
  const dialogCheck = async (label, open) => {
    await openChannel(page, S.text);
    const opener = await open();
    await settle(page, 400);
    const r = await page.evaluate(() => {
      const d = document.querySelector('[role=dialog],[role=alertdialog]');
      const nav = document.querySelector('nav[aria-label="Servers"]');
      const bgHidden = !!(nav && (nav.closest('[inert],[aria-hidden=true]')));
      return { hasDialog: !!d, modal: d?.getAttribute('aria-modal'), named: !!(d?.getAttribute('aria-label') || d?.getAttribute('aria-labelledby')), focusInside: !!(d && d.contains(document.activeElement)), focusedOnOpen: `${document.activeElement?.tagName}:${(document.activeElement?.getAttribute('aria-label') || document.activeElement?.getAttribute('placeholder') || document.activeElement?.textContent || '').trim().slice(0, 30)}`, backgroundInertOrHidden: bgHidden };
    });
    let escaped = false; const outside = [];
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => { const d = document.querySelector('[role=dialog],[role=alertdialog]'); return !d || d.contains(document.activeElement); });
      if (!inside) { outside.push(i); escaped = true; break; }
    }
    await page.keyboard.press('Escape'); await settle(page, 300);
    const closed = await page.locator('[role=dialog],[role=alertdialog]').count() === 0;
    const returned = opener ? await page.evaluate((sel) => { const e = document.activeElement; return e ? `${e.tagName}:${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30)}` : 'none'; }) : null;
    return { label, ...r, trapBroken: escaped, closedByEscape: closed, focusAfterClose: returned };
  };
  P.dialogs = [];
  P.dialogs.push(await dialogCheck('User settings', async () => { await page.getByRole('button', { name: 'User settings' }).first().focus(); await page.keyboard.press('Enter'); return true; }));
  P.dialogs.push(await dialogCheck('Quick switcher', async () => { await page.keyboard.press('Control+k'); return true; }));
  P.dialogs.push(await dialogCheck('Create server', async () => { await page.getByRole('button', { name: 'Add a server' }).focus(); await page.keyboard.press('Enter'); return true; }));
  P.dialogs.push(await dialogCheck('Server settings', async () => {
    await page.getByText(`A11y Guild ${RUN}`).first().click();
    await page.getByRole('menuitem', { name: 'Server settings' }).or(page.getByRole('button', { name: 'Server settings' })).first().click();
    return true;
  }));

  // 6. Menus: keyboard open + arrow keys + Escape.
  await openChannel(page, S.text);
  const row = page.locator('[id^="message-"]').filter({ hasText: `hello from alice ${RUN}` }).first();
  await row.click({ button: 'right' });
  await settle(page, 200);
  const menuFocus0 = await page.evaluate(() => `${document.activeElement?.getAttribute('role')}:${document.activeElement?.textContent?.trim().slice(0, 30)}`);
  await page.keyboard.press('ArrowDown');
  const menuFocus1 = await page.evaluate(() => `${document.activeElement?.getAttribute('role')}:${document.activeElement?.textContent?.trim().slice(0, 30)}`);
  await page.keyboard.press('Escape'); await settle(page, 200);
  P.contextMenu = { focusOnOpen: menuFocus0, afterArrowDown: menuFocus1, closedByEscape: (await page.getByRole('menu').count()) === 0 };
  // Keyboard-only way to open the message context menu? (Shift+F10 / ContextMenu key)
  await row.hover(); await row.focus().catch(() => {});
  await page.keyboard.press('Shift+F10'); await settle(page, 200);
  P.contextMenu.shiftF10Opens = (await page.getByRole('menu').count()) > 0;
  await closeAll(page);
  // Server dropdown menu (the header button carries aria-haspopup="menu").
  await page.locator('button[aria-haspopup="menu"]').filter({ hasText: `A11y Guild ${RUN}` }).first().focus();
  await page.keyboard.press('Enter'); await settle(page, 200);
  const sdFocus = await page.evaluate(() => `${document.activeElement?.getAttribute('role')}:${document.activeElement?.textContent?.trim().slice(0, 30)}`);
  await page.keyboard.press('ArrowDown');
  const sdFocus2 = await page.evaluate(() => `${document.activeElement?.getAttribute('role')}:${document.activeElement?.textContent?.trim().slice(0, 30)}`);
  await page.keyboard.press('Escape'); await settle(page, 200);
  P.serverDropdown = { focusOnOpen: sdFocus, afterArrowDown: sdFocus2, closedByEscape: (await page.getByRole('menu').count()) === 0 };

  // Focus ring screenshots (rail button, composer).
  await page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: 'Add a server' }).focus();
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  await page.screenshot({ path: path.join(OUT, 'a11y-focus-rail.png'), clip: { x: 0, y: 0, width: 330, height: 330 } });
  P.railFocusStyle = await page.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); const nav = e.closest('nav'); return `${e.getAttribute('aria-label')} outline=${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} offset=${cs.outlineOffset}; ancestor overflow=${[...(function* (n) { while (n && n !== nav) { yield getComputedStyle(n).overflow; n = n.parentElement; } })(e.parentElement)].join(',')}`; });
  await composer(page).focus();
  await page.screenshot({ path: path.join(OUT, 'a11y-focus-composer.png'), clip: { x: 312, y: 740, width: 820, height: 110 } });

  // Server rail + channel list arrow keys.
  await page.getByRole('navigation', { name: 'Servers' }).locator('button,a,[tabindex="0"]').first().focus();
  const rail0 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.title || document.activeElement?.textContent?.trim().slice(0, 30));
  await page.keyboard.press('ArrowDown');
  const rail1 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.title || document.activeElement?.textContent?.trim().slice(0, 30));
  P.serverRailArrows = { rail0, rail1, moved: rail0 !== rail1 };

  // 7. Target size (WCAG 2.5.8): interactive elements < 24x24 without spacing.
  const targetScan = async (label) => page.evaluate((label) => {
    const els = [...document.querySelectorAll('button,a[href],[role=button],[role=menuitem],[role=tab],[role=option],input[type=checkbox],input[type=radio],[role=switch]')]
      .filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('[aria-hidden=true]'); });
    const small = [];
    for (const e of els) {
      const r = e.getBoundingClientRect();
      if (r.width >= 24 && r.height >= 24) continue;
      // Spacing exception: a 24px circle centred on the target must not intersect another target.
      const cx = r.x + r.width / 2; const cy = r.y + r.height / 2;
      const clash = els.some((o) => {
        if (o === e || o.contains(e) || e.contains(o)) return false;
        const q = o.getBoundingClientRect();
        const dx = Math.max(q.x - cx, 0, cx - (q.x + q.width)); const dy = Math.max(q.y - cy, 0, cy - (q.y + q.height));
        return Math.hypot(dx, dy) < 12;
      });
      if (clash) small.push(`${(e.getAttribute('aria-label') || e.title || e.textContent || e.tagName).trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return { label, total: els.length, failing: small.length, samples: [...new Set(small)].slice(0, 25) };
  }, label);
  P.targetSize = [];
  await openChannel(page, S.text);
  await page.locator('[id^="message-"]').filter({ hasText: `hello from alice ${RUN}` }).first().hover();
  P.targetSize.push(await targetScan('server-chat (hovering a message)'));
  await page.getByRole('button', { name: 'User settings' }).first().click(); await settle(page);
  P.targetSize.push(await targetScan('user-settings'));
  await closeAll(page);

  // 8. Role colour contrast vs message canvas (dark #313338, light #ffffff) and member list (#2b2d31 / #f2f3f5).
  const rc = await api(page, 'GET', `/api/servers/${S.server}/roles`).catch(() => []);
  const roles = (Array.isArray(rc) ? rc : rc.roles ?? []).filter((r) => r.color && r.color !== '#000000' && r.color !== 0);
  const toHex = (c) => (typeof c === 'number' ? `#${c.toString(16).padStart(6, '0')}` : c);
  const DISCORD_ROLE_PALETTE = ['#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#607d8b',
    '#11806a', '#1f8b4c', '#206694', '#71368a', '#ad1457', '#c27c0e', '#a84300', '#992d22', '#979c9f', '#546e7a'];
  P.roleColorContrast = [...new Set([...roles.map((r) => toHex(r.color)), ...DISCORD_ROLE_PALETTE])].map((hex) => ({
    color: hex, darkCanvas: ratio(hex, '#313338'), lightCanvas: ratio(hex, '#ffffff'), darkMembers: ratio(hex, '#2b2d31'), lightMembers: ratio(hex, '#f2f3f5')
  }));
  // Is any role-colour contrast adjustment applied at render time?
  await openChannel(page, S.text);
  P.renderedRoleColors = await page.evaluate(() => [...document.querySelectorAll('[id^="message-"] [style*="color"]')].slice(0, 6).map((e) => `${e.textContent.trim().slice(0, 20)} -> ${getComputedStyle(e).color}`));

  // 9. Reduced motion: OS preference and in-app setting.
  const rmCtx = await newContext(browser, { storageState: aliceState, reducedMotion: 'reduce' });
  const rm = await rmCtx.newPage();
  await rm.goto(chanUrl(S.text)); await composer(rm).waitFor();
  P.reducedMotion = await rm.evaluate(() => {
    const els = [...document.querySelectorAll('*')];
    const moving = els.filter((e) => { const cs = getComputedStyle(e); return (parseFloat(cs.transitionDuration) > 0.01) || (cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01); });
    return { osReduce: matchMedia('(prefers-reduced-motion: reduce)').matches, stillAnimatedElements: moving.length, samples: moving.slice(0, 5).map((e) => e.className?.toString().slice(0, 60)) };
  });
  const smooth = await rm.evaluate(() => [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).scrollBehavior === 'smooth').length);
  P.reducedMotion.smoothScrollElements = smooth;
  await rmCtx.close();

  // 10. Reflow at 320 CSS px (1280 @ 400%) and 200% zoom (683px).
  const reflow = async (w, h, label) => {
    const c = await newContext(browser, { storageState: aliceState, viewport: { width: w, height: h } });
    const p = await c.newPage();
    await p.goto(chanUrl(S.text)); await p.getByRole('navigation', { name: 'Servers' }).waitFor(); await settle(p, 800);
    const r = await p.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      bodyScrollW: document.body.scrollWidth,
      composerVisible: !!document.querySelector('textarea[aria-label^="Message"], [role="textbox"][aria-label^="Message"]')?.getBoundingClientRect().width,
      clippedButtons: [...document.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1); }).length
    }));
    const shot = path.join(OUT, `a11y-reflow-${label}.png`);
    await p.screenshot({ path: shot });
    await c.close();
    return { label, w, h, ...r, horizontalScroll: r.scrollW > r.clientW + 1, shot };
  };
  P.reflow = [await reflow(320, 256, '400pct-320x256'), await reflow(683, 430, '200pct-683x430'), await reflow(320, 640, '320x640')];

  // 11. In-app zoom 200% (the Appearance slider scales rem).
  // 12. Text spacing (WCAG 1.4.12 bookmarklet values).
  await openChannel(page, S.text);
  P.textSpacing = await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';
    document.head.appendChild(s);
    const clipped = [...document.querySelectorAll('button, a, span, div, p, h1, h2, h3, label')].filter((e) => {
      if (!e.childNodes.length || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return false;
      const cs = getComputedStyle(e);
      const clips = cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden';
      return clips && (e.scrollHeight > e.clientHeight + 2) && cs.textOverflow !== 'ellipsis' && !/truncate|line-clamp/.test(e.className);
    });
    const out = clipped.slice(0, 12).map((e) => `${e.tagName}.${String(e.className).slice(0, 50)} "${e.textContent.trim().slice(0, 30)}" ${e.clientHeight}/${e.scrollHeight}`);
    s.remove();
    return { clippedCount: clipped.length, samples: out };
  });
  await page.screenshot({ path: path.join(OUT, 'a11y-text-spacing.png') });

  // 13. Thai rendering: font actually used and vertical clipping of stacked marks.
  P.thai = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[id^="message-"] *')].find((e) => /ภาษาไทย/.test(e.textContent) && e.children.length === 0);
    if (!el) return { found: false };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { found: true, fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight, height: Math.round(r.height), lang: el.closest('[lang]')?.getAttribute('lang') };
  });
  const thaiRow = page.locator('[id^="message-"]').filter({ hasText: 'ภาษาไทย' }).first();
  await thaiRow.screenshot({ path: path.join(OUT, 'a11y-thai-render.png') }).catch(() => {});
  P.fontsLoaded = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].map((f) => `${f.family}:${f.status}`).slice(0, 12); });

  // 14. Focus visible on light theme (outline colour contrast vs canvas).
  await setTheme(page, 'light');
  await openChannel(page, S.text);
  await composer(page).focus();
  await page.keyboard.press('Shift+Tab');
  P.lightFocus = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return `${document.activeElement?.tagName} outline=${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} shadow=${cs.boxShadow}`; });
  await setTheme(page, 'dark');

  // 15. Accessibility settings page: which Discord options exist.
  await page.getByRole('button', { name: 'User settings' }).first().click();
  await page.getByRole('dialog', { name: 'User settings' }).getByRole('button', { name: 'Accessibility', exact: true }).first().click();
  await settle(page, 300);
  P.a11ySettingsText = (await page.getByRole('dialog', { name: 'User settings' }).innerText()).split('\n').filter(Boolean).slice(0, 80);
  await page.screenshot({ path: path.join(OUT, 'a11y-settings-accessibility-tab.png') });
  await closeAll(page);

  // 16. Toast live region.
  await openChannel(page, S.text);
  await page.getByText(`A11y Guild ${RUN}`).first().click();
  await page.getByRole('menuitem', { name: 'Invite people' }).or(page.getByRole('button', { name: 'Invite people' })).first().click().catch(() => {});
  await settle(page, 400);
  P.toast = await page.evaluate(() => {
    const t = [...document.querySelectorAll('body *')].reverse().find((e) => /Invite link copied|copied/i.test(e.textContent) && e.getBoundingClientRect().width > 0);
    if (!t) return 'no toast found';
    const live = t.closest('[aria-live],[role=status],[role=alert]');
    return live ? `live: role=${live.getAttribute('role')} aria-live=${live.getAttribute('aria-live')}` : `NOT in live region: ${t.tagName}.${String(t.className).slice(0, 60)}`;
  });

  await ctx.close();
  return P;
}

// --- main -------------------------------------------------------------------
let aliceState; let bobState;
async function main() {
  console.log(`a11y scan ${RUN} -> ${BASE}  (out: ${OUT})`);
  await bootServer();
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  try {
    const ac = await newContext(browser); const a = await ac.newPage();
    const bc = await newContext(browser); const b = await bc.newPage();
    await register(a, alice); await register(b, bob);
    await seed(a, b);
    console.log('seeded', JSON.stringify({ ...S, roles: S.roles.length, messages: S.messages.length }));
    aliceState = await ac.storageState(); bobState = await bc.storageState();
    await ac.close(); await bc.close();

    if (!flag('probes-only')) {
      let views = buildViews();
      if (opt('views')) { const want = opt('views').split(','); views = views.filter((v) => want.some((w) => v.name.includes(w))); }
      const results = await scanMatrix(browser, views);
      const partial = opt('only') || opt('views') ? '-partial' : '';
      fs.writeFileSync(path.join(OUT, `axe-results${partial}.json`), JSON.stringify(results, null, 2));
      // Per-view table: rules/nodes for each theme x viewport.
      const table = {};
      for (const r of results) (table[r.view] ??= {})[`${r.theme}/${r.viewport}`] = r.ok ? `${r.rules}/${r.nodes}` : 'n/a';
      console.log('\n== per view (rules/nodes) ==');
      for (const [view, cols] of Object.entries(table)) console.log(view.padEnd(40), Object.entries(cols).map(([k, x]) => `${k}=${x}`).join('  '));
      // Summary: rule -> views
      const byRule = {};
      for (const r of results.filter((x) => x.ok)) for (const v of r.violations) {
        byRule[v.id] ??= { impact: v.impact, tags: v.tags, help: v.help, nodes: 0, views: new Set() };
        byRule[v.id].nodes += v.nodes; byRule[v.id].views.add(`${r.view}[${r.theme}/${r.viewport}]`);
      }
      console.log('\n== axe rules ==');
      for (const [id, x] of Object.entries(byRule).sort((m, n) => n[1].nodes - m[1].nodes)) {
        console.log(`${x.impact.padEnd(9)} ${id.padEnd(32)} nodes=${String(x.nodes).padStart(4)} views=${x.views.size} ${x.tags.join(',')}`);
      }
      const fails = results.filter((r) => !r.ok);
      if (fails.length) console.log(`\n${fails.length} view setups failed (see axe-results.json)`);
    }
    if (!flag('no-probes')) {
      const P = await probes(browser);
      fs.writeFileSync(path.join(OUT, 'probes.json'), JSON.stringify(P, null, 2));
      console.log('\n== probes written to probes.json ==');
    }
  } finally {
    await browser.close().catch(() => {});
    stopServer();
  }
}

main().catch((err) => { console.error(err); stopServer(); process.exit(1); });
