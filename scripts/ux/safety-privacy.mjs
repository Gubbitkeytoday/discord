#!/usr/bin/env node
// ============================================================================
//  UX persona panel — "safety-privacy" group.
//
//  Role-plays three personas against a running instance (UX_BASE, default
//  http://localhost:7050) and records success / time / clicks per task plus a
//  screenshot at every friction point:
//    mai    — Thai streamer being harassed (th, 1366x768 laptop)
//    alex   — privacy-conscious German developer (de, 1366x768, keyboard + passkey)
//    fatima — Indonesian parent checking safety for her 15-year-old (id, 360x740
//             low-end Android, 4x CPU throttle, Fast 3G)
//  A second browser context plays the harasser / stranger.
//
//  Boot the server like scripts/e2e/run.mjs does (SERVE_STATIC=1, throwaway
//  DB_PATH/STORAGE_ROOT, ALLOW_DEV_IDENTITY=0), then:
//    node scripts/ux/safety-privacy.mjs [mai|alex|fatima ...]
//  Env: UX_BASE, UX_SHOTS, CHROMIUM_PATH
// ============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.UX_BASE || 'http://localhost:7050';
const SHOTS = process.env.UX_SHOTS
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const RUN = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'correct-horse-battery-9';
fs.mkdirSync(SHOTS, { recursive: true });

const en = (await import(path.join(ROOT, 'src/i18n/en.js'))).default;
const dict = {
  en,
  th: (await import(path.join(ROOT, 'src/i18n/th.js'))).default,
  de: (await import(path.join(ROOT, 'src/i18n/locales/de.js'))).default,
  id: (await import(path.join(ROOT, 'src/i18n/locales/id.js'))).default
};
/** Label in the persona's language, falling back to English like the app does. */
const L = (lang, key, vars = {}) => {
  const s = dict[lang]?.[key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
};
const rx = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

// --- measurement ------------------------------------------------------------
const results = [];
const ACTIVE = {};
const findings = [];
let clicks = 0;
async function task(persona, name, fn) {
  const t0 = Date.now();
  clicks = 0;
  let ok = true; let note = '';
  try { note = (await fn()) ?? ''; } catch (err) { ok = false; note = String(err.message).split('\n')[0].slice(0, 220); for (const [who, pg] of Object.entries(ACTIVE)) await shot(pg, persona, 'FAIL-' + name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '-' + who); }
  const row = { persona, name, ok, secs: Math.round((Date.now() - t0) / 100) / 10, clicks, note };
  results.push(row);
  console.log(`${ok ? 'PASS' : 'FAIL'} [${persona}] ${name} ${row.secs}s ${clicks} clicks ${note}`);
}
const note = (persona, text) => { findings.push({ persona, text }); console.log(`  NOTE [${persona}] ${text}`); };
async function shot(page, persona, slug) {
  const file = path.join(SHOTS, `persona-safety-privacy-${persona}-${slug}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}
/** Click that counts toward the task's click budget. */
async function tap(loc, opts = {}) { clicks += 1; await loc.first().click({ timeout: 8000, ...opts }); }
const vis = (loc, t = 8000) => loc.first().waitFor({ state: 'visible', timeout: t });
const exists = async (loc, t = 1500) => loc.first().waitFor({ state: 'visible', timeout: t }).then(() => true, () => false);

// --- shared flows ------------------------------------------------------------
async function registerUI(page, lang, username) {
  await page.goto(BASE + '/');
  await tap(page.getByRole('button', { name: L(lang, 'auth.register') }).or(page.getByRole('button', { name: 'Sign up' })));
  await page.getByLabel(rx(L(lang, 'auth.username'))).first().fill(username);
  await page.getByLabel(new RegExp('^' + L(lang, 'auth.password'))).first().fill(PASSWORD);
  await tap(page.locator('form button[type=submit]'));
  try { await vis(page.getByRole('navigation').first(), 15000); } catch (err) {
    await shot(page, 'register', `fail-${username}`);
    throw new Error(`register ${username} failed: ${(await page.locator('form').innerText().catch(() => '')).replace(/\n+/g, ' | ').slice(0, 200)}`);
  }
  // First-run onboarding modal, if any.
  await page.keyboard.press('Escape').catch(() => {});
}
async function api(page, method, url, body) {
  const r = await page.request.fetch(BASE + url, {
    method, data: body, headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' }
  });
  let json = null; try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status(), json };
}
async function openSettings(page, lang) {
  await tap(page.getByRole('button', { name: L(lang, 'sidebar.userSettings') }));
  await vis(page.getByRole('dialog', { name: L(lang, 'sidebar.userSettings') }));
  return page.getByRole('dialog', { name: L(lang, 'sidebar.userSettings') });
}
async function sendMessage(page, text) {
  const box = page.locator('textarea[aria-label], [role="textbox"][aria-label]').last();
  await box.click();
  await box.fill(text);
  await page.keyboard.press('Enter');
}

const meId = async (page) => (await api(page, 'GET', '/api/auth/me')).json?.user?.id;
const dialog = (page, text) => page.locator('[role="dialog"], [role="alertdialog"]').filter(text ? { hasText: text } : {}).last();
const rail = (page, lang) => page.getByRole('navigation', { name: L(lang, 'sidebar.servers') });

// ============================================================================
//  Persona 1 — Mai (th): harassed streamer.
// ============================================================================
async function mai({ browser }) {
  const P = 'mai'; const lang = 'th';
  const mctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'th-TH', colorScheme: 'dark' });
  const hctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'en-US' });
  const m = await mctx.newPage(); const h = await hctx.newPage();
  Object.assign(ACTIVE, { mai: m, creep: h });
  const maiName = `mai_${RUN}`; const creep = `fan4ever_${RUN}`;

  await task(P, 'register (Thai, cold start)', async () => {
    await registerUI(m, lang, maiName);
    await shot(m, P, '01-first-screen');
  });
  // Setup (not a UX task): Mai's fan server + a permanent invite.
  const srv = (await api(m, 'POST', '/api/servers', { name: 'Mai Stream Fans' })).json;
  const invite = (await api(m, 'POST', `/api/servers/${srv.id}/invites`, { maxAge: 0 })).json?.code;
  const maiId = await meId(m);
  await m.reload();
  await m.keyboard.press('Escape').catch(() => {});

  await task('creep', 'harasser joins from invite and DMs Mai', async () => {
    await registerUI(h, 'en', creep);
    await h.goto(`${BASE}/invite/${invite}`);
    await tap(h.getByRole('button', { name: /Accept invite/ }));
    await vis(h.getByText('Mai Stream Fans'));
    // A stranger needs nothing but a shared server: member list → right-click → Message.
    const members = h.locator('aside[aria-label*="ember" i]');
    if (!(await exists(members, 1500))) await tap(h.getByTitle('Member list'));
    await tap(members.getByText(maiName), { button: 'right' });
    await tap(h.getByRole('menuitem', { name: 'Message' }));
    const dm = { status: 'ui' };
    for (const text of ['hey mai 👀', 'why u ignoring me', 'you are ugly and nobody watches your stream', 'i know which city you live in', 'answer me']) {
      await sendMessage(h, text); await h.waitForTimeout(300);
    }
    await shot(h, P, '02-creep-dm');
    return `open DM → HTTP ${dm.status}`;
  });

  const fr1 = await api(h, 'POST', '/api/friends/requests', { username: maiName, note: 'plz accept 🥺' });
  note(P, `creep friend request #1 → HTTP ${fr1.status}`);

  await task(P, 'notice & open the abusive DM', async () => {
    await m.waitForTimeout(800);
    await shot(m, P, '03-notification-state');
    await tap(rail(m, lang).getByTitle(L(lang, 'dm.directMessages')));
    await shot(m, P, '04-home');
    await tap(m.getByRole('button', { name: new RegExp(creep) }).or(m.getByText(creep)));
    await vis(m.getByText('you are ugly'));
    await shot(m, P, '05-dm-open');
  });

  await task(P, 'report the threatening message', async () => {
    const row = m.locator('[id^="message-"]').filter({ hasText: 'i know which city' });
    await row.first().hover();
    await shot(m, P, '06-hover-toolbar');
    const hoverReport = row.locator(`button[title*="${L(lang, 'chat.report')}"], button[aria-label*="${L(lang, 'chat.report')}"]`);
    if (await exists(hoverReport, 800)) await tap(hoverReport);
    else {
      note(P, 'no Report button on the hover toolbar — had to discover right-click');
      await tap(row, { button: 'right' });
      await shot(m, P, '07-context-menu');
      await tap(m.getByRole('menuitem', { name: L(lang, 'chat.reportMessage') }).or(m.getByText(L(lang, 'chat.reportMessage'))));
    }
    const dlg = dialog(m, L(lang, 'chat.reportBody'));
    await vis(dlg);
    await shot(m, P, '08-report-dialog');
    note(P, `report dialog: ${(await dlg.innerText()).replace(/\n+/g, ' | ').slice(0, 300)}`);
    const input = dlg.locator('textarea, input').first();
    if (await exists(input, 800)) await input.fill('ขู่ว่ารู้ว่าฉันอยู่เมืองไหน');
    await tap(dlg.getByRole('button', { name: L(lang, 'chat.report') }));
    await m.waitForTimeout(500);
    await shot(m, P, '09-report-sent');
  });

  await task(P, 'block the harasser', async () => {
    await shot(m, P, '10-dm-header');
    const blockInHeader = m.getByRole('button', { name: L(lang, 'dm.block'), exact: true });
    if (await exists(blockInHeader, 800)) await tap(blockInHeader);
    else {
      note(P, 'no Block in DM header — clicked the username on a message');
      await tap(m.locator('[id^="message-"]').filter({ hasText: 'hey mai' }).getByText(creep));
      await m.waitForTimeout(400);
      await shot(m, P, '11-profile-popout');
      await tap(m.getByRole('button', { name: L(lang, 'dm.block') }).or(m.getByTitle(L(lang, 'dm.block'))));
    }
    const dlg = dialog(m, L(lang, 'dm.blockBody'));
    await vis(dlg);
    await shot(m, P, '12-block-confirm');
    note(P, `block dialog: ${(await dlg.innerText()).replace(/\n+/g, ' | ')}`);
    await tap(dlg.getByRole('button', { name: L(lang, 'dm.block') }));
    await m.waitForTimeout(800);
    await shot(m, P, '13-after-block-modal');
    await m.keyboard.press('Escape');
    await m.waitForTimeout(300);
    await shot(m, P, '13b-after-block-dm');
  });

  await task('creep', 'what the harasser sees after the block', async () => {
    await sendMessage(h, 'hello?? did u block me');
    await h.waitForTimeout(1000);
    await shot(h, P, '14-creep-after-block');
    const fr = await api(h, 'POST', '/api/friends/requests', { username: maiName });
    note(P, `creep friend request after block → HTTP ${fr.status} ${JSON.stringify(fr.json)?.slice(0, 160)}`);
    const prof = await api(h, 'GET', `/api/users/${maiId}`);
    note(P, `creep reads Mai profile → HTTP ${prof.status} ${JSON.stringify(prof.json)?.slice(0, 240)}`);
    await tap(rail(h, 'en').getByTitle('Mai Stream Fans'));
    await h.waitForTimeout(800);
    await shot(h, P, '15-creep-server-view');
  });

  await task(P, 'find the blocked list again', async () => {
    await tap(rail(m, lang).getByTitle(L(lang, 'dm.directMessages')));
    await tap(m.getByRole('button', { name: L(lang, 'dm.friends') }).first());
    await tap(m.getByRole('button', { name: L(lang, 'dm.blocked'), exact: true }).or(m.getByRole('tab', { name: L(lang, 'dm.blocked') })));
    await vis(m.getByText(creep));
    await shot(m, P, '16-blocked-list');
  });

  await task(P, 'restrict DMs + friend requests (Privacy & Safety)', async () => {
    const dlg = await openSettings(m, lang);
    await shot(m, P, '17-settings-open');
    await tap(dlg.getByRole('button', { name: L(lang, 'settings.privacyTab') }));
    await shot(m, P, '18-privacy-tab');
    const group = (key) => dlg.getByRole('radiogroup', { name: L(lang, key) });
    await tap(group('privacy.allowDmsFrom').getByRole('radio', { name: new RegExp(L(lang, 'privacy.dmFriends')) }));
    await tap(group('privacy.friendRequests').getByRole('radio', { name: new RegExp(L(lang, 'privacy.frNone')) }));
    await m.waitForTimeout(1500);
    await group('privacy.friendRequests').scrollIntoViewIfNeeded();
    await shot(m, P, '19-privacy-set');
    const saved = await api(m, 'GET', '/api/settings/preferences');
    note(P, `privacy saved on server: ${JSON.stringify(saved.json?.privacy ?? saved.json)?.slice(0, 200)}`);
    const again = await api(h, 'POST', '/api/dms', { recipientId: maiId });
    note(P, `blocked creep opens DM after friends-only → HTTP ${again.status} ${JSON.stringify(again.json)?.slice(0, 120)}`);
  });

  await task(P, 'look for a "message requests" filter', async () => {
    const dlg = m.getByRole('dialog', { name: L(lang, 'sidebar.userSettings') });
    const search = dlg.getByPlaceholder(L(lang, 'settings.searchPlaceholder'));
    await search.first().fill('คำขอข้อความ');
    await m.waitForTimeout(300);
    await shot(m, P, '20-search-message-requests');
    await search.first().fill('');
    throw new Error('no message-requests inbox or spam filter exists; only a friends-only switch');
  });

  await task(P, 'turn on streamer mode', async () => {
    const dlg = m.getByRole('dialog', { name: L(lang, 'sidebar.userSettings') });
    await tap(dlg.getByRole('button', { name: L(lang, 'settings.streamerTab') }));
    await shot(m, P, '21-streamer-tab');
    // A real user clicks the row title first. It does nothing; then the switch.
    await tap(dlg.getByText(L(lang, 'streamer.enable'), { exact: true }));
    await m.waitForTimeout(300);
    const sw = dlg.getByRole('switch', { name: L(lang, 'streamer.enable') });
    if ((await sw.getAttribute('aria-checked')) !== 'true') {
      note(P, 'clicking the streamer-mode row label did not toggle it; had to hit the small switch');
      await tap(sw);
    }
    await m.waitForTimeout(300);
    await shot(m, P, '22-streamer-on');
    await m.keyboard.press('Escape');
    await m.waitForTimeout(300);
    await shot(m, P, '22b-app-in-streamer-mode');
  });

  // Block evasion: the harasser makes an alt, joins the same fan server, pings Mai in public.
  await task('creep', 'alt account evades the block while Mai is live', async () => {
    const actx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'en-US' });
    const a = await actx.newPage();
    await registerUI(a, 'en', `not_fan4ever_${RUN}`);
    await a.goto(`${BASE}/invite/${invite}`);
    await tap(a.getByRole('button', { name: /Accept invite/ }));
    await vis(a.getByText('Mai Stream Fans'));
    const dm = await api(a, 'POST', '/api/dms', { recipientId: maiId });
    note(P, `alt account opens DM with Mai (friends-only on) → HTTP ${dm.status} ${JSON.stringify(dm.json)?.slice(0, 120)}`);
    await a.getByText('general').first().click();
    await sendMessage(a, `@${maiName} u cant block me lol. new account 😈`);
    await a.waitForTimeout(1200);
    await shot(m, P, '22c-mai-sees-alt-ping-in-streamer-mode');
    await shot(a, P, '22d-alt-view');
    const fr = await api(a, 'POST', '/api/friends/requests', { username: maiName });
    note(P, `alt friend request (friend requests = nobody) → HTTP ${fr.status} ${JSON.stringify(fr.json)?.slice(0, 140)}`);
    await actx.close();
  });

  await task(P, 'hide online status (appear offline)', async () => {
    await m.waitForTimeout(300);
    await shot(m, P, '23-before-status');
    await tap(m.getByRole('button', { name: new RegExp(`${maiName}|${L(lang, 'status.label')}`) }).first());
    await m.waitForTimeout(300);
    await shot(m, P, '24-status-menu');
    await tap(m.getByText(L(lang, 'status.invisible'), { exact: true }));
    await m.waitForTimeout(800);
    const members = await api(h, 'GET', `/api/servers/${srv.id}/members`);
    const list = Array.isArray(members.json) ? members.json : members.json?.members ?? [];
    const me = list.find((x) => (x.username ?? x.user?.username) === maiName);
    note(P, `creep sees Mai status after invisible: ${me?.status ?? me?.user?.status ?? 'n/a'}`);
  });

  await task(P, 'delete her own message', async () => {
    await tap(rail(m, lang).getByTitle('Mai Stream Fans'));
    await m.waitForTimeout(500);
    await sendMessage(m, 'ไลฟ์คืนนี้ 2 ทุ่มนะ ย้ายบ้านแล้ว');
    const row = m.locator('[id^="message-"]').filter({ hasText: 'ไลฟ์คืนนี้' });
    await vis(row);
    await row.first().hover();
    await shot(m, P, '25-own-message-hover');
    const del = row.locator(`button[title*="${L(lang, 'chat.deleteMessage')}"], button[aria-label*="${L(lang, 'chat.deleteMessage')}"]`);
    if (await exists(del, 800)) await tap(del);
    else { await tap(row, { button: 'right' }); await tap(m.getByRole('menuitem', { name: L(lang, 'chat.deleteMessage') })); }
    const dlg = dialog(m, L(lang, 'chat.deleteMessage'));
    await vis(dlg);
    await shot(m, P, '26-delete-confirm');
    await tap(dlg.getByRole('button', { name: new RegExp('^' + L(lang, 'common.delete')) }));
    await m.waitForTimeout(500);
    if (await m.getByText('ไลฟ์คืนนี้').count()) throw new Error('message still visible');
  });

  await mctx.close(); await hctx.close();
}

// ============================================================================
//  Persona 2 — Alex (de): privacy-conscious developer, keyboard + passkeys.
// ============================================================================
async function alex({ browser }) {
  const P = 'alex'; const lang = 'de';
  const { generateCode } = await import(path.join(ROOT, 'lib/totp.js'));
  const actx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'de-DE', colorScheme: 'light', acceptDownloads: true });
  const sctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'en-US' });
  const a = await actx.newPage(); const s = await sctx.newPage();
  for (const k of Object.keys(ACTIVE)) delete ACTIVE[k];
  Object.assign(ACTIVE, { alex: a, stranger: s });
  const alexName = `alex_dev_${RUN}`; const strangerName = `kai_${RUN}`;
  let secret = null;

  await task(P, 'register (German)', async () => { await registerUI(a, lang, alexName); await shot(a, P, '01-first-screen'); });
  // Setup: a public dev community both Alex and a stranger are in.
  await registerUI(s, 'en', strangerName);
  const srv = (await api(s, 'POST', '/api/servers', { name: 'Rust Berlin' })).json;
  const inv = (await api(s, 'POST', `/api/servers/${srv.id}/invites`, { maxAge: 0 })).json?.code;
  await api(a, 'POST', `/api/invites/${inv}/accept`);
  const alexId = await meId(a);
  await a.reload(); await a.keyboard.press('Escape').catch(() => {});

  await task(P, 'set pronouns + bio; understand username vs display name', async () => {
    const dlg = await openSettings(a, lang);
    await shot(a, P, '02-settings-profile');
    await a.locator('#profile-display-name').fill('Alex 🏳️‍⚧️');
    await a.locator('#profile-pronouns').fill('sie/ihr');
    await a.locator('#profile-bio').fill('Backend dev. Rust, Postgres. Bitte keine DMs ohne Kontext.');
    await shot(a, P, '03-profile-dirty');
    const save = dlg.getByRole('button', { name: new RegExp(`^(${L(lang, 'common.saveChanges')}|${L(lang, 'common.save')})$`) });
    await tap(save);
    await a.waitForTimeout(600);
    const usernameEditable = await dlg.getByLabel(new RegExp(`^${L(lang, 'auth.username')}`)).count();
    if (!usernameEditable) note(P, 'no username field anywhere in Profile; no copy explains username (@handle, unique) vs display name');
    await shot(a, P, '04-profile-saved');
  });

  await task(P, 'review Privacy & Safety; set profile to friends-only', async () => {
    const dlg = a.getByRole('dialog', { name: L(lang, 'sidebar.userSettings') });
    await tap(dlg.getByRole('button', { name: L(lang, 'settings.privacyTab') }));
    await shot(a, P, '05-privacy-de');
    await tap(dlg.getByRole('radiogroup', { name: L(lang, 'privacy.profileVisibility') }).getByRole('radio', { name: new RegExp(L(lang, 'privacy.profileFriends')) }));
    await a.waitForTimeout(600);
    await dlg.getByRole('radiogroup', { name: L(lang, 'privacy.allowDmsFrom') }).scrollIntoViewIfNeeded();
    await shot(a, P, '06-privacy-de-lower');
    // Is there a "preview my profile as a stranger" affordance?
    if (!(await exists(dlg.getByText(/Vorschau|preview|als .* ansehen|view as/i), 500))) note(P, 'no "view my profile as someone else" preview');
  });

  await task('stranger', 'what a stranger in a shared server sees', async () => {
    const prof = await api(s, 'GET', `/api/users/${alexId}`);
    note(P, `stranger GET profile → ${JSON.stringify(prof.json)?.slice(0, 400)}`);
    const gp = await api(s, 'GET', `/api/servers/${srv.id}/profile/${alexId}`);
    note(P, `stranger GET server-profile (friends-only set) → ${JSON.stringify(gp.json?.effective ?? gp.json)?.slice(0, 300)}`);
    await s.goto(BASE + '/');
    await tap(rail(s, 'en').getByTitle('Rust Berlin'));
    const members = s.locator('aside[aria-label*="ember" i]');
    if (!(await exists(members, 1500))) await tap(s.getByTitle('Member list'));
    await tap(members.getByText(/Alex/));
    await s.waitForTimeout(600);
    await shot(s, P, '07-stranger-sees-profile');
  });

  await task(P, 'active sessions: spot and revoke an unknown device', async () => {
    // A second login ("her phone" / an attacker) in a fresh context.
    const pctx = await browser.newContext({ ...devicesFor('Pixel 7'), locale: 'de-DE' });
    const p = await pctx.newPage();
    await p.goto(BASE + '/');
    await p.getByLabel(rx(L(lang, 'auth.username'))).first().fill(alexName);
    await p.getByLabel(new RegExp('^' + L(lang, 'auth.password'))).first().fill(PASSWORD);
    await p.locator('form button[type=submit]').click();
    await vis(p.getByRole('navigation').first(), 15000);
    const dlg = a.getByRole('dialog', { name: L(lang, 'sidebar.userSettings') });
    await tap(dlg.getByRole('button', { name: L(lang, 'settings.accountTab') }));
    await a.waitForTimeout(800);
    await dlg.getByText(L(lang, 'security.devices')).scrollIntoViewIfNeeded();
    await shot(a, P, '08-sessions');
    note(P, `session rows: ${(await dlg.getByText(L(lang, 'security.devices')).locator('xpath=../..').innerText()).replace(/\n+/g, ' | ').slice(0, 400)}`);
    const same = await dlg.getByRole('button', { name: L(lang, 'security.revoke'), exact: true }).count();
    note(P, `${same} buttons in Settings share the accessible name "${L(lang, 'security.revoke')}" (app sign-out + per-device revoke)`);
    await tap(dlg.locator('div.p-3').filter({ hasText: 'Pixel 7' }).getByRole('button', { name: L(lang, 'security.revoke'), exact: true }));
    await a.waitForTimeout(800);
    if (await exists(a.getByRole('alertdialog'), 400)) note(P, 'revoke asked for confirmation');
    else note(P, 'revoking a device is instant: no confirm, no toast');
    await shot(a, P, '09b-session-revoked');
    note(P, `revoked phone was on URL ${p.url()}`);
    await p.reload();
    note(P, `after reload the phone shows: ${(await p.locator('body').innerText()).slice(0, 120).replace(/\n+/g, ' | ')}`);
    await p.waitForTimeout(1500);
    const kicked = await exists(p.getByLabel(new RegExp('^' + L(lang, 'auth.password'))), 4000);
    await shot(p, P, '10-revoked-device');
    await pctx.close();
    if (!kicked) throw new Error('revoked device still signed in');
  });

  await task(P, 'enable 2FA (authenticator app)', async () => {
    const dlg = a.getByRole('dialog', { name: L(lang, 'sidebar.userSettings') });
    await dlg.getByText(L(lang, 'security.twoFactor')).first().scrollIntoViewIfNeeded();
    await tap(dlg.getByRole('button', { name: L(lang, 'security.enableMfa') }));
    const code = dlg.locator('code').first();
    await vis(code);
    if (await dlg.locator('form').filter({ has: code }).locator('input[type=password]').count()) note(P, 'MFA enrolment asked for the password');
    else note(P, 'enabling 2FA did NOT ask for the current password — an open session is enough');
    await dlg.getByText(L(lang, 'security.scanHint')).scrollIntoViewIfNeeded();
    await shot(a, P, '11-mfa-enrol');
    secret = (await code.innerText()).replace(/\s+/g, '');
    await dlg.getByLabel(L(lang, 'security.sixDigitCode')).fill(generateCode(secret));
    await tap(dlg.getByRole('button', { name: L(lang, 'security.confirm'), exact: true }));
    await vis(dlg.getByText(L(lang, 'security.saveRecoveryCodes')));
    await shot(a, P, '12-recovery-codes');
    const hasDownload = await exists(dlg.getByRole('button', { name: /herunterladen|download/i }), 300);
    if (!hasDownload) note(P, 'recovery codes: only a tiny "copy" link; no download/print, no "I saved them" confirmation');
  });

  await task(P, 'add a passkey', async () => {
    const cdp = await actx.newCDPSession(a);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
    const dlg = a.getByRole('dialog', { name: L(lang, 'sidebar.userSettings') });
    const settingsSearch = dlg.getByPlaceholder(L(lang, 'settings.searchPlaceholder'));
    await settingsSearch.fill('Passkey');
    await a.waitForTimeout(300);
    await shot(a, P, '13-search-passkey');
    await settingsSearch.fill('');
    if (!(await exists(dlg.getByText(L(lang, 'passkeys.title'), { exact: true }), 1500))) {
      throw new Error('no Passkeys section anywhere in Settings (PasskeysSection.jsx is never rendered) and no passkey button on the login screen');
    }
    await tap(dlg.getByRole('button', { name: L(lang, 'passkeys.add') }));
    await a.waitForTimeout(500);
    await shot(a, P, '14-passkey-reauth');
    const pw = a.locator('input[type=password]:visible').last();
    if (await exists(pw, 1500)) {
      await pw.fill(PASSWORD);
      const codeBox = a.locator('input[autocomplete="one-time-code"]:visible').last();
      if (await exists(codeBox, 500)) await codeBox.fill(generateCode(secret));
      await tap(a.getByRole('button', { name: new RegExp(`^(${L(lang, 'security.confirm')}|${L(lang, 'passkeys.add')}|Continue|Weiter)`) }).last());
    }
    await a.waitForTimeout(2000);
    await shot(a, P, '15-passkey-added');
    if (!(await exists(dlg.getByText(L(lang, 'passkeys.added')).or(dlg.getByText(new RegExp(L(lang, 'passkeys.created', { date: '' })))), 3000))) throw new Error('passkey not listed');
  });

  await task(P, 'download my data (GDPR export)', async () => {
    const dlg = a.getByRole('dialog', { name: L(lang, 'sidebar.userSettings') });
    await dlg.getByText(L(lang, 'security.yourData')).scrollIntoViewIfNeeded();
    await shot(a, P, '16-your-data');
    const [dl] = await Promise.all([a.waitForEvent('download', { timeout: 10000 }), tap(dlg.getByRole('button', { name: L(lang, 'security.requestExport') }))]);
    const file = path.join(SHOTS, `persona-safety-privacy-alex-export-${RUN}.json`);
    await dl.saveAs(file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    note(P, `export file ${dl.suggestedFilename()} keys: ${Object.keys(data).join(', ')}; sessions/IPs included: ${JSON.stringify(data).includes('ip_address')}; passkeys: ${JSON.stringify(data).includes('passkey')}`);
    await a.waitForTimeout(500);
    await shot(a, P, '17-after-export');
  });

  await task(P, 'delete account (wrong password first, then for real)', async () => {
    const dlg = a.getByRole('dialog', { name: L(lang, 'sidebar.userSettings') });
    await tap(dlg.getByRole('button', { name: L(lang, 'security.deleteAccount'), exact: true }));
    const form = dlg.getByRole('form', { name: L(lang, 'security.deleteAccount') });
    await vis(form);
    await form.scrollIntoViewIfNeeded();
    await shot(a, P, '18-delete-form');
    await form.locator('input[type=password]').fill('wrong-password-123');
    const codeBox = form.locator('input[autocomplete="one-time-code"]');
    if (await codeBox.count()) await codeBox.fill(generateCode(secret));
    await tap(form.getByRole('button', { name: L(lang, 'security.deleteConfirm') }));
    await a.waitForTimeout(800);
    await shot(a, P, '19-delete-wrong-password');
    await form.locator('input[type=password]').fill(PASSWORD);
    await a.waitForTimeout(31000 - (Date.now() % 30000) > 25000 ? 0 : 0);
    if (await codeBox.count()) await codeBox.fill(generateCode(secret));
    await tap(form.getByRole('button', { name: L(lang, 'security.deleteConfirm') }));
    await a.waitForTimeout(2500);
    await shot(a, P, '20-after-delete');
    const prof = await api(s, 'GET', `/api/users/${alexId}`);
    note(P, `stranger sees deleted Alex → ${JSON.stringify(prof.json)?.slice(0, 200)}`);
  });

  await actx.close(); await sctx.close();
}
function devicesFor(name) { const d = devices[name]; return d ? { ...d } : { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }; }
// ============================================================================
//  Persona 3 — Fatima (id): parent vetting the app for her 15-year-old,
//  on a cheap Android (360x740, 4x CPU throttle, Fast 3G). She signs up as
//  her son "Raka" to see what he would see.
// ============================================================================
async function fatima({ browser }) {
  const P = 'fatima'; const lang = 'id';
  const fctx = await browser.newContext({
    viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'id-ID',
    userAgent: 'Mozilla/5.0 (Linux; Android 11; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
  });
  const sctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'en-US' });
  const f = await fctx.newPage(); const s = await sctx.newPage();
  for (const k of Object.keys(ACTIVE)) delete ACTIVE[k];
  Object.assign(ACTIVE, { fatima: f, stranger: s });
  const cdp = await fctx.newCDPSession(f);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  const kid = `raka_${RUN}`; const stranger = `gamer_bro_${RUN}`;

  await task(P, 'cold start + sign up as her son (what does it ask?)', async () => {
    const t0 = Date.now();
    await f.goto(BASE + '/');
    await vis(f.locator('form'), 30000);
    note(P, `login screen interactive after ${Math.round((Date.now() - t0) / 100) / 10}s on Fast 3G + 4x CPU`);
    await shot(f, P, '01-login-mobile');
    await tap(f.getByRole('button', { name: L(lang, 'auth.register') }));
    await f.waitForTimeout(400);
    await shot(f, P, '02-signup-form');
    const text = await f.locator('form').innerText();
    if (!/lahir|umur|usia|birth|age/i.test(text)) note(P, 'sign-up asks for no date of birth / age, and shows no terms, community guidelines or minimum age');
    await f.getByLabel(rx(L(lang, 'auth.username'))).first().fill(kid);
    await f.getByLabel(new RegExp('^' + L(lang, 'auth.password'))).first().fill(PASSWORD);
    await tap(f.locator('form button[type=submit]'));
    await vis(f.getByRole('navigation').first(), 30000);
    await f.keyboard.press('Escape').catch(() => {});
    await f.waitForTimeout(800);
    await shot(f, P, '03-first-screen-mobile');
  });

  await registerUI(s, 'en', stranger);
  const srv = (await api(s, 'POST', '/api/servers', { name: 'Free Robux Giveaway' })).json;
  const inv = (await api(s, 'POST', `/api/servers/${srv.id}/invites`, { maxAge: 0 })).json?.code;
  const nsfw = (await api(s, 'POST', '/api/channels', { server_id: srv.id, name: 'after-dark', type: 'text' })).json;
  await api(s, 'PATCH', `/api/channels/${nsfw.id}`, { nsfw: true });

  await task(P, 'find a safety / family / age setting (≤3 taps?)', async () => {
    let taps = 0;
    const gear = f.getByRole('button', { name: L(lang, 'sidebar.userSettings') });
    if (!(await exists(gear, 1500))) { note(P, 'settings gear not visible on first mobile screen'); await tap(f.getByRole('button', { name: /channels|kanal|menu/i })); taps++; }
    await tap(gear); taps++;
    await f.waitForTimeout(800);
    await shot(f, P, '04-settings-mobile');
    const dlg = f.getByRole('dialog', { name: L(lang, 'sidebar.userSettings') });
    for (const q of ['anak', 'usia', 'keluarga', 'orang tua', 'sensitif']) {
      await dlg.getByPlaceholder(L(lang, 'settings.searchPlaceholder')).fill(q);
      await f.waitForTimeout(300);
      const hits = (await dlg.locator('nav button').allInnerTexts()).join(', ');
      note(P, `settings search "${q}" → ${hits || 'nothing'}`);
      if (q === 'anak') await shot(f, P, '05-search-anak');
    }
    await dlg.getByPlaceholder(L(lang, 'settings.searchPlaceholder')).fill('');
    await tap(dlg.getByRole('button', { name: L(lang, 'settings.privacyTab') })); taps++;
    await f.waitForTimeout(800);
    await shot(f, P, '06-privacy-mobile');
    note(P, `Privacy & Safety reached in ${taps} taps; no age, parental, family-centre or teen-default setting exists`);
    const scan = dlg.getByRole('radiogroup', { name: L(lang, 'privacy.dmScanning') });
    note(P, `media filter options: ${(await scan.innerText()).replace(/\n+/g, ' | ')}`);
    const dms = dlg.getByRole('radiogroup', { name: L(lang, 'privacy.allowDmsFrom') });
    await dms.scrollIntoViewIfNeeded();
    await shot(f, P, '07-privacy-dm-defaults');
    await f.keyboard.press('Escape');
  });

  await task(P, 'kid accepts a stranger invite; can the stranger DM him? (defaults)', async () => {
    await f.goto(`${BASE}/invite/${inv}`);
    await f.waitForTimeout(1500);
    await shot(f, P, '08-invite-screen');
    await tap(f.getByRole('button', { name: L(lang, 'invites.acceptInvite') }));
    await f.waitForTimeout(2500);
    const kidId = await meId(f);
    const dm = await api(s, 'POST', '/api/dms', { recipientId: kidId });
    note(P, `stranger opens DM to the 15-year-old with default settings → HTTP ${dm.status}`);
    const fr = await api(s, 'POST', '/api/friends/requests', { username: kid, note: 'wanna free robux? add me' });
    note(P, `stranger friend request → HTTP ${fr.status}`);
    await s.goto(BASE + '/');
    await tap(rail(s, 'en').getByTitle('Direct messages'));
    await tap(s.getByRole('button', { name: new RegExp(kid) }).or(s.getByText(kid)));
    await sendMessage(s, 'hey how old r u? send a pic 📸 and ill give u 1000 robux');
    await f.waitForTimeout(2500);
    await shot(f, P, '09-kid-gets-dm-notice');
  });

  await task(P, 'age-restricted channel: what stops a 15-year-old?', async () => {
    await f.goto(BASE + '/');
    await f.waitForTimeout(2000);
    await tap(rail(f, lang).getByTitle('Free Robux Giveaway'));
    await f.waitForTimeout(1200);
    await shot(f, P, '10-server-mobile');
    const ch = f.getByText('after-dark').first();
    if (!(await exists(ch, 1500))) await tap(f.getByRole('button', { name: /Show channels|Tampilkan kanal/i }));
    await tap(f.getByText('after-dark').first());
    await f.waitForTimeout(1000);
    await shot(f, P, '11-nsfw-gate');
    await tap(f.getByRole('button', { name: L(lang, 'chat.nsfwEnter') }));
    await f.waitForTimeout(800);
    await shot(f, P, '12-nsfw-entered');
    note(P, 'age gate is one "Continue" tap: no DOB, no account age flag, remembered afterwards');
  });

  await task(P, 'report the stranger\'s DM on a phone and understand what happens', async () => {
    if (!(await exists(rail(f, lang).getByTitle(L(lang, 'dm.directMessages')), 800))) {
      await tap(f.getByRole('button', { name: L(lang, 'sidebar.openChannels') })); // the ☰ drawer button
      await f.waitForTimeout(500);
    }
    await tap(rail(f, lang).getByTitle(L(lang, 'dm.directMessages')));
    await f.waitForTimeout(800);
    await tap(f.getByRole('button', { name: new RegExp(stranger) }).or(f.getByText(stranger)));
    await f.waitForTimeout(1200);
    await shot(f, P, '13-dm-mobile');
    const row = f.locator('[id^="message-"]').filter({ hasText: 'robux' }).first();
    // Long-press (500ms touch-hold), the gesture every Android app uses.
    const box = await row.boundingBox();
    if (box) {
      const pt = { x: box.x + box.width * 0.6, y: box.y + box.height - 12 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
      await f.waitForTimeout(800);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      clicks++;
    }
    await f.waitForTimeout(600);
    await shot(f, P, '14-long-press');
    let item = f.getByRole('menuitem', { name: L(lang, 'chat.reportMessage') });
    if (!(await exists(item, 1200))) {
      note(P, 'long-press did not open a menu with Report; tried tap');
      await row.tap(); clicks++;
      await f.waitForTimeout(500);
      await shot(f, P, '14b-tap-message');
      const more = row.locator('button[title], button[aria-label]').last();
      if (await exists(more, 800)) { await more.tap({ timeout: 5000 }).catch(() => {}); clicks++; }
      item = f.getByRole('menuitem', { name: L(lang, 'chat.reportMessage') });
    }
    await tap(item);
    const dlg = dialog(f, L(lang, 'chat.reportBody'));
    await vis(dlg);
    await shot(f, P, '15-report-mobile');
    note(P, `report dialog (id): ${(await dlg.innerText()).replace(/\n+/g, ' | ')}`);
    await dlg.locator('input, textarea').first().fill('Orang asing minta foto anak saya');
    await tap(dlg.getByRole('button', { name: L(lang, 'chat.report') }));
    await f.waitForTimeout(800);
    await shot(f, P, '16-report-sent-mobile');
    const again = await api(f, 'GET', `/api/reports?serverId=${srv.id}`);
    note(P, `can the reporter see her report status anywhere? GET /api/reports → HTTP ${again.status}`);
  });

  await fctx.close(); await sctx.close();
}
// @@PERSONAS@@

// --- runner -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const which = process.argv.slice(2);
const want = (p) => !which.length || which.includes(p);
try {
  const ctx = { browser, devices };
  if (want('mai')) await mai(ctx);
  if (want('alex')) await alex(ctx);
  if (want('fatima')) await fatima(ctx);
} finally {
  await browser.close();
  fs.writeFileSync(path.join(SHOTS, `persona-safety-privacy-results-${RUN}.json`), JSON.stringify({ results, findings }, null, 2));
  console.table(results.map(({ persona, name, ok, secs, clicks: c }) => ({ persona, name, ok, secs, clicks: c })));
}
