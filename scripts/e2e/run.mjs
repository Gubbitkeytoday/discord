#!/usr/bin/env node
import crypto from 'node:crypto';
// ============================================================================
//  End-to-end browser test: two real users, one real server process.
//
//  - Boots `node server.js` on a throwaway SQLite DB + storage dir (port 4550 by
//    default), serving the built SPA (runs `vite build` when dist/ is missing
//    or when --build is passed). ALLOW_DEV_IDENTITY=0, so only the real
//    register/login + session cookie path is exercised.
//  - Drives two independent Chromium contexts (alice = owner, bob = invitee)
//    through the main product flows and checks each one is visible to the
//    *other* user in realtime where that matters.
//  - Every step is isolated: a failure is recorded with a screenshot and the
//    run continues, so one bug does not hide the rest.
//  - Console errors and 4xx/5xx responses are collected per user and printed.
//
//  Setup:  npm ci && npm i --no-save playwright-core   (Chromium binary is not
//          downloaded; point CHROMIUM_PATH at one, default /opt/pw-browsers/chromium)
//  Usage:  npm run e2e [-- --build] [-- --headed] [-- --keep]
//  Env:    E2E_PORT, E2E_SHOTS (screenshot dir), CHROMIUM_PATH
//  Exit code is non-zero when any step fails.
// ============================================================================

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run: npm i --no-save playwright-core');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.E2E_PORT || 4550);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.E2E_SHOTS
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const T = 8000; // default per-assertion timeout
const RUN = crypto.randomBytes(4).toString('hex').slice(0, 5);
const PASSWORD = 'correct-horse-battery-9';

fs.mkdirSync(SHOTS, { recursive: true });

// --- tiny test runner -------------------------------------------------------
const results = [];
let pages = {};
async function step(name, fn, { critical = false } = {}) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  \x1b[32mPASS\x1b[0m ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const shots = [];
    for (const [who, p] of Object.entries(pages)) {
      if (!p || p.isClosed()) continue;
      const file = path.join(SHOTS, `e2e-${slug}-${who}.png`);
      await p.screenshot({ path: file }).catch(() => {});
      shots.push(file);
    }
    const lines = String(err?.message ?? err).split('\n');
    const waiting = lines.find((l) => /waiting for/.test(l))?.trim();
    const error = lines[0] + (waiting ? ` [${waiting.slice(0, 200)}]` : '');
    results.push({ name, ok: false, error, shots });
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}: ${error}`);
    if (critical) throw new Error(`critical step failed: ${name}`);
  }
}
const visible = (loc, what, timeout = T) =>
  loc.first().waitFor({ state: 'visible', timeout }).catch(() => { throw new Error(`not visible: ${what}`); });
const hidden = (loc, what, timeout = T) =>
  loc.first().waitFor({ state: 'hidden', timeout }).catch(() => { throw new Error(`still visible: ${what}`); });
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// --- server lifecycle -------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-discord-'));
let server;
let serverLog = '';

async function bootServer() {
  if (args.has('--build') || !fs.existsSync(path.join(ROOT, 'dist/index.html'))) {
    console.log('building SPA…');
    const r = spawnSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('vite build failed');
  }
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PUBLIC_URL: BASE,
      CORS_ORIGIN: '',
      DB_PATH: path.join(tmp, 'e2e.db'),
      STORAGE_ROOT: path.join(tmp, 'uploads'),
      SERVE_STATIC: '1',
      ALLOW_DEV_IDENTITY: '0',
      MAIL_TRANSPORT: 'console',
      LOG_LEVEL: 'warn',
      LOG_FORMAT: 'pretty'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${serverLog}`);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy:\n${serverLog}`);
}

function stopServer() {
  if (server && server.exitCode === null) server.kill('SIGTERM');
  if (!args.has('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
}

// --- per-user browser context with diagnostics --------------------------------
const diagnostics = []; // { who, kind, text }
async function newUser(browser, who, contextOpts = {}) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 860 },
    permissions: ['clipboard-read', 'clipboard-write'],
    ...contextOpts
  });
  // The sandbox has no internet; third-party font/favicon hosts would only add
  // noise. They are recorded separately so the dependency stays visible.
  await context.route((url) => !url.href.startsWith(BASE) && /^https?:/.test(url.href), (route) => {
    diagnostics.push({ who, kind: 'external', text: route.request().url() });
    return route.abort();
  });
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/ERR_FAILED|net::ERR_BLOCKED|ERR_INTERNET_DISCONNECTED/.test(text) && /Failed to load resource/.test(text)) return;
    diagnostics.push({ who, kind: 'console', text });
  });
  page.wsFrames = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    if (typeof f.payload === 'string') page.wsFrames.push(f.payload);
  }));
  page.on('pageerror', (e) => diagnostics.push({ who, kind: 'pageerror', text: String(e.stack ?? e).slice(0, 400) }));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(BASE)) {
      diagnostics.push({ who, kind: `http ${r.status()}`, text: `${r.request().method()} ${r.url().replace(BASE, '')}` });
    }
  });
  return { context, page };
}

/** A solid-colour RGB PNG, built by hand so no image library is needed. */
function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([88, 101, 242]))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

const homeBadge = async (page) => {
  const txt = await page.getByRole('navigation', { name: 'Servers' }).getByTitle('Direct messages').locator('..').innerText().catch(() => '');
  return Number(txt.replace(/\D/g, '') || 0);
};

// --- page helpers -----------------------------------------------------------
const msgRow = (page, text) => page.locator('[id^="message-"]').filter({ hasText: text });
const composer = (page) => page.locator('textarea[aria-label^="Message"], [role="textbox"][aria-label^="Message"]').first();

async function sendMessage(page, text) {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
  await visible(msgRow(page, text), `own message "${text}"`);
}

async function hoverAction(page, text, title) {
  // The hover toolbar exists only for the row under the pointer. A virtualized
  // list can shift a row after it is hovered (a message arrives, an image or
  // font finishes loading), leaving the pointer over another row — re-hover
  // and retry, as a person would.
  const row = msgRow(page, text).first();
  const btn = row.locator(`button[title^="${title}"]`).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.hover();
    if (await btn.isVisible().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  await btn.click({ timeout: T });
}

async function contextAction(page, text, item) {
  const row = msgRow(page, text).first();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).or(page.getByRole('button', { name: item })).first().click({ timeout: T });
}

async function register(page, username) {
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel(/Username/).fill(username);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await visible(page.getByRole('navigation', { name: 'Servers' }), 'app shell after register');
}

async function login(page, username) {
  await page.getByLabel(/Username/).fill(username);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await visible(page.getByRole('navigation', { name: 'Servers' }), 'app shell after login');
}

// ============================================================================
async function main() {
  console.log(`e2e run ${RUN} → ${BASE} (tmp ${tmp})`);
  await bootServer();
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: !args.has('--headed') });
  const alice = `alice_${RUN}`;
  const bob = `bob_${RUN}`;
  const A = await newUser(browser, 'alice');
  const B = await newUser(browser, 'bob');
  pages = { alice: A.page, bob: B.page };
  const a = A.page;
  const b = B.page;
  const serverName = `E2E Guild ${RUN}`;
  const channelName = `e2e-chat-${RUN}`;
  let inviteUrl = null;
  let channelUrl = null;

  try {
    await step('register alice (UI)', () => register(a, alice), { critical: true });
    await step('register bob (UI)', () => register(b, bob), { critical: true });

    await step('alice creates a server', async () => {
      await a.getByRole('button', { name: 'Add a server' }).click();
      await a.getByRole('button', { name: /Create my own/ }).click();
      const name = a.getByPlaceholder('e.g. Chill Squad HQ');
      await name.fill(serverName);
      await a.getByRole('button', { name: /^Create$/ }).click();
      await visible(a.getByText(serverName).first(), 'server name in sidebar');
      // A new server offers its invite dialog straight away; dismiss it here.
      const offer = a.getByRole('dialog', { name: /Invite friends/ });
      if (await offer.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) {
        await a.keyboard.press('Escape');
        await hidden(offer, 'invite dialog closed', 3000);
      }
    }, { critical: true });

    await step('alice creates a text channel', async () => {
      await a.getByRole('button', { name: 'Create text channel' }).or(a.getByTitle('Create text channel')).first().click();
      await a.getByPlaceholder('new-channel').fill(channelName);
      await a.locator('[role="dialog"]').getByRole('button', { name: /Create channel/ }).click();
      await visible(a.getByRole('button', { name: new RegExp(channelName) }).or(a.getByText(channelName)), 'channel in sidebar');
      await visible(composer(a), 'composer in new channel');
    }, { critical: true });

    await step('alice creates an invite link', async () => {
      await a.getByText(serverName).first().click(); // server dropdown
      await a.getByRole('menuitem', { name: 'Invite people' }).or(a.getByRole('button', { name: 'Invite people' })).first().click();
      // The invite dialog shows the link itself (it used to be copied silently).
      const field = a.getByRole('dialog', { name: /Invite friends/ }).getByLabel('Invite link');
      await visible(field, 'invite dialog');
      await a.waitForFunction(() => /\/invite\//.test(document.getElementById('invite-link')?.value ?? ''), null, { timeout: T });
      inviteUrl = await field.inputValue();
      await a.keyboard.press('Escape');
      assert(inviteUrl && /\/invite\/\w+/.test(inviteUrl), `no invite url (got ${inviteUrl})`);
    }, { critical: true });

    await step('bob opens invite link and joins', async () => {
      await b.goto(inviteUrl);
      await visible(b.getByText(/invited you to join|been invited to join/), 'invite screen');
      await b.getByRole('button', { name: /Accept invite/ }).click();
      await visible(b.getByText(serverName), 'server visible for bob');
      await b.getByText(channelName).first().click();
      await visible(composer(b), 'bob composer');
    }, { critical: true });

    // --- messaging ---------------------------------------------------------
    const m1 = `hello from alice ${RUN}`;
    await step('alice sends → bob receives in realtime', async () => {
      await a.getByText(channelName).first().click();
      await sendMessage(a, m1);
      channelUrl = a.url();
      await visible(msgRow(b, m1), 'message arrives for bob', 6000);
    });

    await step('typing indicator shows for other user', async () => {
      const box = composer(b);
      await box.click();
      await box.pressSequentially('typing…', { delay: 40 });
      await visible(a.getByText(/is typing/), 'typing indicator on alice', 6000);
      await box.fill('');
    });

    const m1edited = `edited by alice ${RUN}`;
    await step('edit message propagates', async () => {
      await hoverAction(a, m1, 'Edit message');
      const edit = a.getByRole('textbox', { name: 'Edit message' }).or(a.locator('textarea[aria-label="Edit message"]'));
      await edit.first().fill(m1edited);
      await edit.first().press('Enter');
      await visible(msgRow(a, m1edited), 'edited text (alice)');
      await visible(msgRow(b, m1edited), 'edited text (bob)');
      await visible(msgRow(b, m1edited).getByText(/edited/), '(edited) marker for bob');
    });

    await step('react propagates', async () => {
      await hoverAction(b, m1edited, 'React with');
      await visible(msgRow(a, m1edited).locator('button[aria-label*="1"], button:has-text("1")'), 'reaction count on alice');
    });

    const reply = `reply from bob ${RUN}`;
    await step('reply shows referenced message', async () => {
      await hoverAction(b, m1edited, 'Reply');
      await visible(b.getByText(/Replying to/i), 'replying banner');
      await sendMessage(b, reply);
      const row = msgRow(a, reply);
      await visible(row, 'reply arrives for alice');
      // Discord shows the replied-to snippet above the reply.
      const txt = await a.locator(`[id^="message-"]`).filter({ hasText: reply }).first().innerText();
      assert(txt.includes(m1edited.slice(0, 12)) || (await a.getByText(m1edited).count()) > 1,
        'reply does not render a reference to the original message');
    });

    await step('pin message and see it in pinned list', async () => {
      await contextAction(a, m1edited, 'Pin message');
      const pinPanel = (pg) => pg.locator('div.w-96').filter({ hasText: 'Pinned messages' });
      await a.getByTitle('Pinned messages').first().click();
      await visible(pinPanel(a).getByText(m1edited), 'pinned list (alice) contains message');
      assert(!(await pinPanel(a).getByText(reply).count()), 'wrong message pinned');
      await a.keyboard.press('Escape');
      await a.waitForTimeout(300);
      const escClosed = !(await pinPanel(a).count());
      if (!escClosed) await pinPanel(a).locator('button').first().click();
      await b.getByTitle('Pinned messages').first().click();
      await visible(pinPanel(b).getByText(m1edited), 'pinned list (bob) contains message');
      await pinPanel(b).locator('button').first().click();
      assert(escClosed, 'Pinned messages popover does not close on Escape (had to click X)');
    });

    const threadName = `thread-${RUN}`;
    const threadMsg = `inside thread ${RUN}`;
    await step('create thread from message and post in it', async () => {
      await contextAction(a, reply, 'Create thread');
      const dlg = a.locator('[role="dialog"]').last();
      await dlg.locator('input').first().fill(threadName);
      await dlg.getByRole('button', { name: /^Create$/ }).click();
      await visible(a.getByText(threadName), 'thread open for alice');
      await sendMessage(a, threadMsg);
      await visible(b.getByText(threadName), 'thread visible in bob sidebar/channel');
      await b.getByText(threadName).first().click();
      await visible(msgRow(b, threadMsg), 'thread message visible for bob');
      // back to the channel
      await a.getByText(channelName).first().click();
      await b.getByText(channelName).first().click();
    });

    await step('mention creates a notification for the mentioned user', async () => {
      const box = composer(b);
      await box.click();
      await box.pressSequentially(`@${alice.slice(0, 6)}`, { delay: 30 });
      await visible(b.getByRole('option', { name: new RegExp(alice) }).or(b.getByText(new RegExp(`${alice}`)).last()), 'mention autocomplete');
      await box.press('Enter');
      await box.pressSequentially(` ping ${RUN}`);
      await box.press('Enter');
      await visible(msgRow(b, `ping ${RUN}`), 'mention message (bob)');
      await visible(msgRow(a, `ping ${RUN}`), 'mention message (alice)');
      await a.waitForTimeout(500);
      const badge = await homeBadge(a);
      await a.getByTitle('Inbox').first().click();
      await visible(a.getByText(`ping ${RUN}`).nth(1), 'mention in alice inbox');
      await a.keyboard.press('Escape');
      assert(badge === 0, `a server-channel mention shows up as ${badge} unread on the Direct Messages (home) icon`);
    });

    await step('upload image attachment', async () => {
      const png = makePng(160, 120);
      await a.locator('input[type="file"]').first().setInputFiles({ name: `pic-${RUN}.png`, mimeType: 'image/png', buffer: png });
      const box = composer(a);
      await box.click();
      await box.fill(`image ${RUN}`);
      await box.press('Enter');
      await visible(msgRow(a, `image ${RUN}`).locator('img[src*="upload"], img[src*="/api/files"], img[alt*="pic-"]'), 'image rendered (alice)', 12000);
      await visible(msgRow(b, `image ${RUN}`).locator('img[src*="upload"], img[src*="/api/files"], img[alt*="pic-"]'), 'image rendered (bob)', 12000);
      const img = msgRow(b, `image ${RUN}`).locator('img').last();
      const bb = await img.boundingBox();
      assert(bb && bb.width >= 40 && bb.height >= 30, `image renders at ${JSON.stringify(bb)}`);
      const src = await img.getAttribute('src');
      const ok = await b.evaluate(async (u) => (await fetch(u)).status, src);
      assert(ok === 200, `image url ${src} → ${ok}`);
    });

    await step('delete message propagates', async () => {
      const doomed = `delete me ${RUN}`;
      await sendMessage(a, doomed);
      await visible(msgRow(b, doomed), 'doomed msg on bob');
      await hoverAction(a, doomed, 'Delete message');
      const confirm = a.locator('[role="dialog"], [role="alertdialog"]').getByRole('button', { name: /^Delete/ });
      if (await confirm.count()) await confirm.first().click();
      await hidden(msgRow(a, doomed), 'deleted msg (alice)');
      await hidden(msgRow(b, doomed), 'deleted msg (bob)');
    });

    await step('search finds a message', async () => {
      const search = a.getByPlaceholder('Search').first();
      await search.fill(`edited by alice`);
      await search.press('Enter');
      await visible(a.getByText(/result/i), 'search results panel');
      const panelHits = await a.getByText(m1edited).count();
      assert(panelHits >= 2, `search results did not include "${m1edited}" (count ${panelHits})`);
    });

    const memberPanel = (pg) => pg.locator('aside[aria-label*="member" i]');
    const ensureMembers = async (pg) => {
      const close = pg.getByRole('button', { name: 'Close' }); // search panel replaces member list
      if (await pg.getByText(/Results for/).count()) await close.first().click().catch(() => {});
      if (!(await memberPanel(pg).count())) await pg.getByTitle('Member list').first().click();
      await visible(memberPanel(pg), 'member list panel');
    };
    await step('member list shows both users (both sides)', async () => {
      await ensureMembers(a);
      await visible(memberPanel(a).getByText(bob), 'bob in alice member list');
      await visible(memberPanel(a).getByText(alice), 'alice in alice member list');
      await ensureMembers(b);
      await visible(memberPanel(b).getByText(alice), 'alice in bob member list');
    });

    await step('owner creates a role in Server settings and assigns it to bob', async () => {
      await a.getByText(serverName).first().click();
      await a.getByRole('menuitem', { name: 'Server settings' }).or(a.getByRole('button', { name: 'Server settings' })).first().click();
      const dlg = a.getByRole('dialog', { name: 'Server settings' });
      await dlg.getByRole('button', { name: /^Roles$/ }).first().click();
      const createBtn = dlg.getByRole('button', { name: /Create role|Role created/ });
      const label = (await createBtn.first().textContent()).trim();
      await createBtn.first().click();
      await visible(dlg.getByRole('button', { name: /new role/ }), 'new role in list');
      await a.keyboard.press('Escape');
      await hidden(dlg, 'server settings closed by Escape', 3000).catch(async () => {
        await dlg.getByRole('button', { name: /close/i }).first().click();
      });
      await ensureMembers(a);
      await memberPanel(a).getByText(bob).first().click({ button: 'right' });
      await a.getByRole('menuitem', { name: 'Roles' }).or(a.getByText('Roles', { exact: true })).first().hover();
      await a.getByRole('menuitemcheckbox', { name: /new role/ }).or(a.getByRole('menuitem', { name: /new role/ })).or(a.getByText('new role', { exact: true })).first().click();
      const sub = a.getByText('new role', { exact: true }).first();
      const box = await sub.boundingBox();
      const vw = a.viewportSize().width;
      await a.keyboard.press('Escape');
      await a.waitForTimeout(300);
      const menuStuck = await a.getByRole('menuitem', { name: 'Kick' }).isVisible();
      if (menuStuck) await a.mouse.click(5, 5);
      const serverId = new URL(a.url()).pathname.split('/')[2];
      const members = await a.evaluate(async (id) => (await fetch(`/api/servers/${id}/members`)).json(), serverId);
      const list = Array.isArray(members) ? members : members.members ?? [];
      const bm = list.find((m) => (m.username ?? m.user?.username) === bob);
      const roleIds = bm?.roles ?? bm?.role_ids ?? [];
      assert(roleIds.length >= 1, `bob has no roles after assignment (${JSON.stringify(bm)?.slice(0, 200)})`);
      assert(!box || box.x + box.width <= vw, `Roles submenu renders off-screen (x=${Math.round(box?.x)}, w=${Math.round(box?.width)}, viewport ${vw})`);
      assert(!menuStuck, 'member context menu does not close on Escape after toggling a role');
      assert(label === 'Create role', `"create role" button is labelled "${label}"`);
    });

    await step('DM between users (bob → alice)', async () => {
      await ensureMembers(b);
      await memberPanel(b).getByText(alice).first().click({ button: 'right' });
      await b.getByRole('menuitem', { name: 'Message' }).or(b.getByRole('button', { name: /^Message$/ })).first().click();
      const dm = `dm hi ${RUN}`;
      await sendMessage(b, dm);
      await a.getByRole('navigation', { name: 'Servers' }).getByTitle('Direct messages').click();
      const entry = a.getByRole('button', { name: new RegExp(bob) }).or(a.getByText(bob));
      await visible(entry, 'DM conversation listed for alice', 6000);
      await entry.first().click();
      await visible(msgRow(a, dm), 'DM arrives for alice');
      const back = `dm back ${RUN}`;
      await sendMessage(a, back);
      await visible(msgRow(b, back), 'DM reply arrives for bob in realtime');
    });

    await step('reload keeps session (cookie persistence)', async () => {
      await a.reload();
      await visible(a.getByRole('navigation', { name: 'Servers' }), 'app shell after reload');
      await a.getByRole('navigation', { name: 'Servers' }).getByTitle(serverName).first().click();
      await a.getByText(channelName).first().click();
      await visible(msgRow(a, m1edited), 'history after reload');
    });

    await step('logout then log back in', async () => {
      await a.getByRole('button', { name: 'User settings' }).first().click();
      await a.getByRole('button', { name: 'Sign out' }).click();
      // Sign-out asks for confirmation first (as Discord's "Log Out" does).
      const confirmOut = a.getByRole('alertdialog').or(a.getByRole('dialog', { name: 'Sign out' }))
        .getByRole('button', { name: 'Sign out' });
      if (await confirmOut.first().isVisible().catch(() => false)) await confirmOut.first().click();
      await visible(a.getByRole('button', { name: 'Log in' }).or(a.getByText('Welcome back!')), 'login screen');
      const me = await a.evaluate(async () => (await fetch('/api/auth/me')).status);
      assert(me === 401, `session still valid after logout (/api/auth/me → ${me})`);
      // While alice sits on the login screen, bob talks in the channel.
      const secret = `after-logout ${RUN}`;
      await sendMessage(b, secret);
      await a.waitForTimeout(1000);
      const leakedToLoggedOut = a.wsFrames.some((f) => f.includes(secret));
      await login(a, alice);
      const staleModal = await a.getByRole('button', { name: 'Sign out' }).isVisible();
      if (staleModal) await a.keyboard.press('Escape');
      await a.getByRole('navigation', { name: 'Servers' }).getByTitle(serverName).first().click();
      await a.getByText(channelName).first().click();
      await visible(msgRow(a, m1edited), 'history after re-login');
      const problems = [];
      if (leakedToLoggedOut) problems.push("signed-out tab still receives bob's new DM over its old socket (socket not disconnected on sign-out)");
      if (staleModal) problems.push('User settings modal is still open after sign-out + sign-in (UI state not reset)');
      assert(!problems.length, problems.join('; '));
    });

    // --- auth edge cases & API hygiene (checked as a real user would hit them) ---
    await step('wrong password shows a readable (English) error', async () => {
      const C = await newUser(browser, 'anon');
      pages.anon = C.page;
      await C.page.goto(BASE + '/');
      await C.page.getByLabel(/Username/).fill(alice);
      await C.page.getByLabel(/^Password/).fill('definitely-wrong');
      await C.page.locator('form button[type=submit]').click();
      const err = C.page.locator('form').getByText(/./).filter({ hasNotText: /Username|Password|Log in|Welcome|glad|Forgot|Need an account|Sign up/i }).last();
      await C.page.waitForTimeout(800);
      const text = (await C.page.locator('form').innerText()).split('\n').find((l) => /[\u0E00-\u0E7F]|invalid|incorrect|wrong/i.test(l)) ?? '';
      await C.page.close();
      delete pages.anon;
      assert(text, 'no error message shown for a wrong password');
      assert(!/[\u0E00-\u0E7F]/.test(text), `error shown in Thai on an English UI: "${text}"`);
    });

    await step('duplicate username is rejected cleanly (4xx, not 500)', async () => {
      const r = await fetch(`${BASE}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: alice, password: 'another-password-123' })
      });
      const body = await r.text();
      assert(r.status >= 400 && r.status < 500, `registering taken username → HTTP ${r.status} ${body.slice(0, 120)}`);
    });

    await step('fresh install has no accounts with a publicly known password', async () => {
      const users = await (await fetch(`${BASE}/api/users`)).json().catch(() => []);
      const seeded = (Array.isArray(users) ? users : []).filter((u) => ![alice, bob].includes(u.username));
      const hijacked = [];
      for (const u of seeded) {
        const r = await fetch(`${BASE}/api/auth/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u.username, password: 'antigravity123' })
        });
        if (r.ok) hijacked.push(u.username);
      }
      assert(!hijacked.length, `seed accounts log in with "antigravity123" (ALLOW_DEV_IDENTITY=0): ${hijacked.join(', ')}`);
    });

    await step('user directory is not public', async () => {
      const r = await fetch(`${BASE}/api/users`);
      const body = r.ok ? await r.json() : null;
      assert(!r.ok, `unauthenticated GET /api/users → ${r.status}, ${body?.length} users (${Object.keys(body?.[0] ?? {}).join(',')})`);
    });

    // --- mobile ------------------------------------------------------------
    await step('mobile 390px: login, open channels drawer, send message', async () => {
      const M = await newUser(browser, 'bob-mobile', {
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2
      });
      pages['bob-mobile'] = M.page;
      const m = M.page;
      const soft = [];
      await m.goto(BASE + '/');
      await login(m, bob);
      const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) soft.push(`horizontal overflow ${overflow}px`);
      await m.getByRole('navigation', { name: 'Servers' }).getByTitle(serverName).first().tap();
      await m.waitForTimeout(500);
      await m.screenshot({ path: path.join(SHOTS, 'e2e-mobile-1-server-opened.png') });
      if (process.env.E2E_DEBUG) console.log(await m.evaluate(() => [[200, 400], [30, 400], [10, 50], [100, 40]].map(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return `${x},${y}: <${el?.tagName} class="${String(el?.className).slice(0, 160)}" label=${el?.getAttribute?.('aria-label')}> rect=${JSON.stringify(el?.getBoundingClientRect())}`;
      }).join('\n')));
      // Picking a server on a phone opens the channel drawer (Discord's own
      // behaviour), so the header's "Show channels" button is behind it. Close
      // it via its backdrop first; the button below must reopen it.
      if (await m.getByText(channelName).first().isVisible()) {
        await m.touchscreen.tap(380, 400); // drawer backdrop
        await m.waitForTimeout(400);
      }
      // The closed channel drawer must be fully off-canvas, not peeking over the rail.
      const drawer = m.locator('div.w-60').filter({ has: m.getByText(serverName) }).first();
      const closedBox = await drawer.boundingBox();
      if (closedBox && closedBox.x + closedBox.width > 0) soft.push(`closed channel drawer still overlaps the screen by ${Math.round(closedBox.x + closedBox.width)}px (covers the server rail)`);
      if (await m.locator('aside[aria-label*="member" i]').isVisible()) {
        const mb = await m.locator('aside[aria-label*="member" i]').boundingBox();
        soft.push(`member list overlay is open by default on a phone and covers ${Math.round(mb.width)}px of the ${390}px chat`);
        await m.touchscreen.tap(30, 400); // its backdrop
        await hidden(m.locator('aside[aria-label*="member" i]'), 'member overlay after tapping backdrop', 3000);
      }
      const opener = m.getByRole('button', { name: 'Show channels' });
      if (await opener.count()) {
        await opener.first().tap();
        await m.waitForTimeout(400);
        await m.screenshot({ path: path.join(SHOTS, 'e2e-mobile-2-drawer-open.png') });
        await m.getByText(channelName).first().tap();
      } else {
        soft.push('no "Show channels" button in a text channel header: a phone user cannot reach any channel but the default one (worked around via URL)');
        await m.goto(channelUrl);
        await m.waitForTimeout(800);
        if (await m.locator('aside[aria-label*="member" i]').isVisible()) await m.touchscreen.tap(30, 400);
      }
      await visible(composer(m), 'composer on mobile');
      const mm = `from phone ${RUN}`;
      await sendMessage(m, mm);
      await visible(msgRow(a, mm), 'mobile message reaches alice');
      // Message actions are hover-only; a touch user needs some way to reply/react.
      await msgRow(m, mm).tap();
      await m.waitForTimeout(300);
      const toolbar = msgRow(m, mm).locator('button[title="Reply"]');
      if (!(await toolbar.isVisible())) {
        await msgRow(m, mm).dispatchEvent('contextmenu');
        await m.waitForTimeout(300);
        const menu = await m.getByRole('menuitem', { name: 'Reply' }).isVisible();
        if (!menu) soft.push('no touch path to message actions (toolbar is hover-only, long-press does nothing)');
        await m.screenshot({ path: path.join(SHOTS, 'e2e-mobile-3-message-actions.png') });
      }
      assert(!soft.length, soft.join('; '));
    });
  } finally {
    await browser.close().catch(() => {});
    stopServer();
  }
}

let fatal = null;
try { await main(); } catch (err) { fatal = err; }

// --- report -------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
for (const f of failed) console.log(`  FAIL ${f.name}: ${f.error}\n       ${f.shots?.join('\n       ') ?? ''}`);
const byKey = new Map();
for (const d of diagnostics) {
  const k = `${d.who} ${d.kind} ${d.text}`;
  byKey.set(k, (byKey.get(k) ?? 0) + 1);
}
if (byKey.size) {
  console.log('\nDiagnostics (console errors, 4xx/5xx, blocked third-party requests):');
  for (const [k, n] of byKey) console.log(`  ${n > 1 ? `[x${n}] ` : ''}${k}`);
}
const serverErrors = serverLog.split('\n').filter((l) => /error|ERR|warn/i.test(l)).slice(0, 40);
if (serverErrors.length) console.log('\nServer log (errors/warnings):\n  ' + serverErrors.join('\n  '));
if (fatal) console.log(`\nFATAL: ${fatal.stack ?? fatal}`);
process.exit(fatal || failed.length ? 1 : 0);
