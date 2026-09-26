#!/usr/bin/env node
// ============================================================================
//  UX persona scenario — "older-nontech" group.
//
//  Somchai (68, Thai, low vision, cheap Android on slow 3G), Linda (55, UK
//  school admin, 1366x768 @125%), Rosa (44, pt-BR bakery owner, iPad).
//
//  Expects a server already running (see scripts/e2e/run.mjs for how to boot
//  one with SERVE_STATIC=1 and a throwaway DB). Usage:
//    UX_BASE=http://localhost:7020 node scripts/ux/older-nontech.mjs [somchai|linda|rosa|all]
//  Screenshots go to UX_SHOTS (default: scratchpad/shots) as
//  persona-older-nontech-*.png; a JSON log of timings/clicks is printed.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { chromium } from 'playwright-core';

const BASE = process.env.UX_BASE || 'http://localhost:7020';
const SHOTS = process.env.UX_SHOTS
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const RUN = crypto.randomBytes(3).toString('hex');
const PW = 'correct-horse-battery-9';
const which = process.argv[2] || 'all';
fs.mkdirSync(SHOTS, { recursive: true });

const log = [];
const shot = async (page, name) => {
  const file = path.join(SHOTS, `persona-older-nontech-${name}.png`);
  await page.screenshot({ path: file }).catch((e) => console.log('shot fail', name, e.message));
  return file;
};
async function task(persona, name, fn) {
  const t0 = Date.now();
  const ctx = { clicks: 0, notes: [] };
  let ok = true; let err = null;
  try { await fn(ctx); } catch (e) { ok = false; err = String(e.message).split('\n')[0].slice(0, 300); }
  const rec = { persona, name, ok, ms: Date.now() - t0, clicks: ctx.clicks, notes: ctx.notes, err };
  log.push(rec);
  console.log(JSON.stringify(rec));
}
const tap = async (ctx, loc, opts = {}) => { ctx.clicks += 1; await loc.first().click({ timeout: 15000, ...opts }); };
const vis = (loc, t = 15000) => loc.first().waitFor({ state: 'visible', timeout: t });
const isVis = (loc, t = 2500) => loc.first().waitFor({ state: 'visible', timeout: t }).then(() => true, () => false);
const composer = (page) => page.locator('textarea[aria-label^="Message"], [role="textbox"][aria-label^="Message"], textarea[aria-label*="ข้อความ"], textarea[aria-label*="Mensagem"], textarea').first();

function makePng(w, h, rgb = [230, 120, 60]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from(rgb))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

async function newCtx(browser, opts = {}, { net, cpu } = {}) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write', 'microphone', 'camera'], ...opts });
  await context.route((u) => !u.href.startsWith(BASE) && /^https?:/.test(u.href), (r) => r.abort());
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.message).slice(0, 200)));
  if (net || cpu) {
    const cdp = await context.newCDPSession(page);
    if (net) { await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, ...net }); }
    if (cpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    page.cdp = cdp;
  }
  return { context, page };
}
const SLOW3G = { latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 };

// API helper (runs inside a logged-in page so the session cookie is used)
const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: j };
}, [method, url, body]);

async function registerUI(page, username, display) {
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: /Sign up|สมัคร|Cadastr|Criar conta|Registr/ }).first().click();
  await page.getByLabel(/Username|ชื่อผู้ใช้|usuário/i).first().fill(username);
  if (display) await page.getByLabel(/Display name|ชื่อที่แสดง|Nome de exibição/i).first().fill(display).catch(() => {});
  await page.getByLabel(/^Password|^รหัสผ่าน|^Senha/i).first().fill(PW);
  await page.locator('form button[type=submit]').click();
  await vis(page.getByRole('navigation').first(), 20000);
}

// ---------------------------------------------------------------------------
export async function somchai(browser) {
  // Grandson "Beam" sets up the family server on a desktop.
  const G = await newCtx(browser, { viewport: { width: 1366, height: 860 }, locale: 'th-TH' });
  const g = G.page;
  await registerUI(g, `beam_${RUN}`, 'บีม');
  const srv = await api(g, 'POST', '/api/servers', { name: 'บ้านเรา 🏠' });
  const serverId = srv.body?.id ?? srv.body?.server?.id;
  const chans = await api(g, 'GET', `/api/servers/${serverId}`);
  const list = Array.isArray(chans.body) ? chans.body : chans.body?.channels ?? [];
  const photos = await api(g, 'POST', '/api/channels', { server_id: serverId, name: 'รูปครอบครัว', type: 'text' });
  const voice = list.find((c) => c.type === 'voice') ?? (await api(g, 'POST', '/api/channels', { server_id: serverId, name: 'โทรคุยกัน', type: 'voice' })).body;
  const photosId = photos.body?.id ?? photos.body?.channel?.id;
  // grandson posts photos with the real UI so they render like real ones
  await g.goto(`${BASE}/channels/${serverId}/${photosId}`);
  await vis(composer(g));
  for (const [i, rgb] of [[1, [230, 120, 60]], [2, [60, 160, 90]]]) {
    await g.locator('input[type="file"]').first().setInputFiles({ name: `grandma-${i}.png`, mimeType: 'image/png', buffer: makePng(800, 600, rgb) });
    await composer(g).fill(i === 1 ? 'รูปวันเกิดคุณยายครับ 🎂' : 'ปู่ดูรูปนี้นะครับ');
    await composer(g).press('Enter');
    await g.waitForTimeout(1200);
  }
  const inv = await api(g, 'POST', `/api/servers/${serverId}/invites`, { maxAge: 0 });
  const code = inv.body?.code ?? inv.body?.invite?.code;
  const inviteUrl = `${BASE}/invite/${code}`;
  console.log('invite', inviteUrl, 'voice', voice?.id, voice?.name, 'status', srv.status, photos.status, inv.status);

  // --- Somchai: cheap Android, slow 3G, CPU 4x, Thai, taps the link from LINE.
  const android = {
    viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'th-TH',
    userAgent: 'Mozilla/5.0 (Linux; Android 11; SM-A022F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
  };
  const S = await newCtx(browser, android, { net: SLOW3G, cpu: 4 });
  const s = S.page;
  const user = `somchai${RUN}`;

  await task('Somchai', 'T1 open invite link from LINE (slow 3G) → first meaningful screen', async (c) => {
    const t0 = Date.now();
    await s.goto(inviteUrl, { waitUntil: 'commit', timeout: 120000 });
    await s.waitForTimeout(3000); await shot(s, 'somchai-01-loading-3s');
    await vis(s.locator('button, input').first(), 120000);
    c.notes.push(`first interactive after ${Date.now() - t0}ms`);
    await s.waitForTimeout(1500);
    await shot(s, 'somchai-02-invite-landing');
    c.notes.push('landing text: ' + (await s.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400));
  });

  await task('Somchai', 'T2 register (Thai, from invite)', async (c) => {
    const signup = s.getByRole('button', { name: /สมัคร|Sign up|ลงทะเบียน|สร้างบัญชี/ });
    if (await isVis(signup, 5000)) await tap(c, signup);
    else c.notes.push('no visible sign-up button on invite screen');
    await s.waitForTimeout(800);
    await shot(s, 'somchai-03-register-form');
    const labels = await s.locator('label').allInnerTexts();
    c.notes.push('labels: ' + labels.join(' | ').replace(/\s+/g, ' ').slice(0, 300));
    // He types a Thai display name as username first (a real-world mistake).
    const u = s.getByLabel(/ชื่อผู้ใช้|Username/i).first();
    c.clicks += 1; await u.fill('สมชาย');
    const d = s.getByLabel(/ชื่อที่แสดง|Display/i).first();
    if (await isVis(d, 1000)) { c.clicks += 1; await d.fill('ปู่สมชาย'); }
    const p = s.getByLabel(/^รหัสผ่าน|^Password/i).first();
    c.clicks += 1; await p.fill('1234');
    await tap(c, s.locator('form button[type=submit]'));
    await s.waitForTimeout(2500);
    await shot(s, 'somchai-04-register-error');
    c.notes.push('after bad attempt: ' + (await s.locator('[role=alert], .text-red-400, .text-d-danger').allInnerTexts().catch(() => [])).join(' | ').slice(0, 300));
    c.clicks += 1; await u.fill(user);
    c.clicks += 1; await p.fill('somchai2511');
    await tap(c, s.locator('form button[type=submit]'));
    await s.waitForTimeout(2500);
    await shot(s, 'somchai-05-register-2');
    const errs = await s.locator('[role=alert]').allInnerTexts().catch(() => []);
    if (errs.length) c.notes.push('2nd attempt msg: ' + errs.join('|').slice(0, 300));
    await vis(s.getByRole('navigation').or(s.getByRole('button', { name: /รับคำเชิญ/ })), 60000);
    await s.waitForTimeout(2500);
    await shot(s, 'somchai-06-after-register');
    c.notes.push('url after register: ' + s.url());
  });

  await task('Somchai', 'T3 land in family server / accept invite', async (c) => {
    const accept = s.getByRole('button', { name: /รับคำเชิญ|ยอมรับ|Accept invite|Aceitar/ });
    if (await isVis(accept, 6000)) { await shot(s, 'somchai-07-accept'); await tap(c, accept); c.notes.push('had to accept invite again after register'); }
    await s.waitForTimeout(4000);
    await shot(s, 'somchai-08-in-server');
    c.notes.push('visible text: ' + (await s.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 500));
  });

  await task('Somchai', 'T4 find & view the family photos', async (c) => {
    const ch = s.getByText(/ครอบคร/);
    if (!(await isVis(ch, 4000))) {
      // on mobile the channel list may be hidden behind a hamburger
      const menu = s.getByRole('button', { name: /แสดงรายการห้อง|Show channels|Mostrar canais/i });
      if (await isVis(menu, 3000)) { await tap(c, menu); await s.waitForTimeout(800); await shot(s, 'somchai-09-drawer'); }
    }
    await tap(c, s.getByText(/ครอบคร/));
    await s.waitForTimeout(5000);
    await shot(s, 'somchai-10-photos-channel');
    const img = s.locator('[id^="message-"] img').filter({ hasNot: s.locator('[class*="avatar"]') }).last();
    await vis(img, 30000);
    await tap(c, img);
    await s.waitForTimeout(2500);
    await shot(s, 'somchai-11-lightbox');
    await s.keyboard.press('Escape').catch(() => {});
    const close = s.getByRole('button', { name: /ปิด|Close/ });
    if (await isVis(close, 1500)) await tap(c, close);
  });

  await task('Somchai', 'T5 say hello + react ❤️ like LINE', async (c) => {
    const box = composer(s);
    await tap(c, box);
    await box.fill('สวัสดีหลานๆ ปู่เข้ามาแล้วนะ');
    await s.waitForTimeout(400);
    await shot(s, 'somchai-12-typing-keyboard');
    const send = s.getByRole('button', { name: /ส่ง|Send/ });
    if (await isVis(send, 1500)) await tap(c, send); else { await box.press('Enter'); c.notes.push('no visible Send button; used Enter'); }
    await s.waitForTimeout(2500);
    // long-press on a photo message for reactions (mobile convention)
    const row = s.locator('[id^="message-"]').filter({ hasText: 'วันเกิด' }).first();
    const bb = await row.boundingBox();
    if (bb) {
      await s.touchscreen.tap(bb.x + bb.width / 2, bb.y + 10);
      await s.waitForTimeout(400);
      c.clicks += 1;
      await row.dispatchEvent('contextmenu');
      await s.waitForTimeout(1200);
      await shot(s, 'somchai-13-longpress-menu');
      c.notes.push('menu text: ' + (await s.locator('[role=menu]').allInnerTexts().catch(() => [])).join('|').replace(/\s+/g, ' ').slice(0, 300));
    }
    await s.keyboard.press('Escape').catch(() => {});
  });

  await task('Somchai', 'T6 join the family voice call', async (c) => {
    const menu = s.getByRole('button', { name: /แสดงรายการห้อง|Show channels|Mostrar canais/i });
    if (await isVis(menu, 2000)) { await tap(c, menu); await s.waitForTimeout(800); }
    await shot(s, 'somchai-14-find-voice');
    const v = s.getByText(voice?.name ?? 'ทั่วไป').last();
    await tap(c, v);
    await s.waitForTimeout(4000);
    await shot(s, 'somchai-15-voice');
    c.notes.push('voice screen: ' + (await s.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400));
    const join = s.getByRole('button', { name: /เข้าห้องเสียง|Join Voice/ });
    if (await isVis(join, 2000)) { await tap(c, join); await s.waitForTimeout(4000); await shot(s, 'somchai-16-in-call'); }
    const leave = s.getByRole('button', { name: /ออกจาก|วางสาย|Disconnect|Leave|ตัดการเชื่อมต่อ/ });
    c.notes.push('hang-up visible: ' + (await isVis(leave, 3000)));
    if (await isVis(leave, 1000)) {
      const b = await leave.first().boundingBox(); c.notes.push('hang-up box ' + JSON.stringify(b));
      await tap(c, leave);
    }
  });

  // --- 200% browser zoom on the same phone (viewport effectively 180 CSS px)
  const Z = await newCtx(browser, { ...android, viewport: { width: 180, height: 370 }, deviceScaleFactor: 4 });
  const z = Z.page;
  await task('Somchai', 'T7 same app at 200% zoom (login + read chat)', async (c) => {
    await z.goto(BASE + '/');
    await z.waitForTimeout(2500);
    await shot(z, 'somchai-17-zoom-login');
    c.clicks += 2;
    await z.getByLabel(/ชื่อผู้ใช้|Username/i).first().fill(user);
    await z.getByLabel(/^รหัสผ่าน|^Password/i).first().fill('somchai2511');
    const w = await z.evaluate(() => document.documentElement.scrollWidth);
    c.notes.push('login scrollWidth ' + w + ' vs 180');
    await tap(c, z.locator('form button[type=submit]'));
    await z.waitForTimeout(4000);
    await shot(z, 'somchai-18-zoom-home');
    await z.goto(`${BASE}/channels/${serverId}/${photosId}`);
    await z.waitForTimeout(4000);
    await shot(z, 'somchai-19-zoom-chat');
    const w2 = await z.evaluate(() => document.documentElement.scrollWidth);
    c.notes.push('chat scrollWidth ' + w2 + ' vs 180');
  });

  await task('Somchai', 'T8 make text bigger inside the app', async (c) => {
    await s.goto(`${BASE}/channels/${serverId}/${photosId}`);
    await s.waitForTimeout(5000);
    const settings = s.getByRole('button', { name: /ตั้งค่าผู้ใช้|User settings|การตั้งค่า/ });
    if (!(await isVis(settings, 3000))) {
      const menu = s.getByRole('button', { name: /แสดงรายการห้อง|Show channels|Mostrar canais/i });
      if (await isVis(menu, 2000)) await tap(c, menu);
    }
    await shot(s, 'somchai-20-where-settings');
    await tap(c, s.getByRole('button', { name: /ตั้งค่าผู้ใช้|User settings/ }));
    await s.waitForTimeout(2000);
    await shot(s, 'somchai-21-settings');
    const appearance = s.getByRole('button', { name: /รูปลักษณ์|Appearance|การแสดงผล/ }).or(s.getByRole('tab', { name: /รูปลักษณ์|Appearance/ }));
    await tap(c, appearance);
    await s.waitForTimeout(1500);
    await shot(s, 'somchai-22-appearance');
    await s.mouse.wheel(0, 1600); await s.waitForTimeout(800);
    await shot(s, 'somchai-23-appearance-scaling');
  });

  console.log('Somchai page errors', s.errors, z.errors);
  await Promise.all([G.context.close(), S.context.close(), Z.context.close()]);
}

// ---------------------------------------------------------------------------
//  Linda — Windows laptop 1366x768 at 125% (=> 1093x614 CSS px), en-GB.
// ---------------------------------------------------------------------------
async function body(page) { return (await page.locator('body').innerText()).replace(/\s+/g, ' '); }
globalThis.linda = async function linda(browser) {
  const L = await newCtx(browser, { viewport: { width: 1093, height: 614 }, deviceScaleFactor: 1.25, locale: 'en-GB', timezoneId: 'Europe/London' });
  const l = L.page;
  const user = `linda_${RUN}`;
  const serverName = 'Oakfield Y3 Parents';
  let inviteUrl = null;

  await task('Linda', 'L1 register', async (c) => {
    await l.goto(BASE + '/');
    await l.waitForTimeout(1200);
    await shot(l, 'linda-01-login');
    await tap(c, l.getByRole('button', { name: 'Sign up' }));
    c.clicks += 3;
    await l.getByLabel(/Username/).fill(user);
    await l.getByLabel(/Display name/).fill('Mrs Linda Hughes');
    await l.getByLabel(/^Password/).fill(PW);
    await tap(c, l.locator('form button[type=submit]'));
    await vis(l.getByRole('navigation', { name: 'Servers' }), 20000);
    await l.waitForTimeout(1500);
    await shot(l, 'linda-02-first-screen');
    c.notes.push('first screen: ' + (await body(l)).slice(0, 300));
  });

  await task('Linda', 'L2 create a server for the parents group', async (c) => {
    const cta = l.getByRole('button', { name: /Create a server|Create server/ });
    if (await isVis(cta, 1500)) await tap(c, cta); else await tap(c, l.getByRole('button', { name: 'Add a server' }));
    await l.waitForTimeout(600);
    await shot(l, 'linda-03-add-server');
    c.notes.push('modal: ' + (await l.locator('[role=dialog]').last().innerText()).replace(/\s+/g, ' ').slice(0, 300));
    await tap(c, l.getByRole('button', { name: /Create my own/ }));
    c.clicks += 1; await l.getByPlaceholder('e.g. Chill Squad HQ').fill(serverName);
    await shot(l, 'linda-04-name-server');
    await tap(c, l.getByRole('button', { name: /^Create$/ }));
    await vis(l.getByText(serverName));
    await l.waitForTimeout(1000);
    await shot(l, 'linda-05-server-created');
    const offer = l.getByRole('dialog', { name: /Invite friends/ });
    if (await isVis(offer, 3000)) {
      await l.waitForFunction(() => /\/invite\//.test(document.getElementById('invite-link')?.value ?? ''), null, { timeout: 8000 }).catch(() => {});
      inviteUrl = await offer.getByLabel('Invite link').inputValue().catch(() => null);
      c.notes.push('invite dialog: ' + (await offer.innerText()).replace(/\s+/g, ' ').slice(0, 300));
      await shot(l, 'linda-06-invite-dialog');
      // Linda wants the link to last all school year
      const sel = offer.locator('select').first();
      if (await isVis(sel, 1000)) {
        c.notes.push('expiry options: ' + (await sel.locator('option').allInnerTexts()).join(', '));
        c.clicks += 1; await sel.selectOption({ label: /Never/.test(await sel.innerText()) ? 'Never' : undefined }).catch(() => {});
        await l.waitForTimeout(1500);
        inviteUrl = await offer.getByLabel('Invite link').inputValue().catch(() => inviteUrl);
        await shot(l, 'linda-07-invite-never');
      }
      await l.keyboard.press('Escape');
    } else c.notes.push('no invite offer after creating server');
  });

  await task('Linda', 'L3 create an #announcements channel', async (c) => {
    const add = l.getByRole('button', { name: /Create text channel|Create channel/ }).or(l.getByTitle(/Create text channel|Create channel/));
    await tap(c, add);
    await l.waitForTimeout(700);
    await shot(l, 'linda-08-create-channel');
    const dlg = l.locator('[role=dialog]').last();
    c.notes.push('create-channel dialog: ' + (await dlg.innerText()).replace(/\s+/g, ' ').slice(0, 400));
    const ann = dlg.getByText('Announcement', { exact: true });
    if (await isVis(ann, 1500)) await tap(c, ann);
    c.clicks += 1; await dlg.getByPlaceholder('new-channel').fill('Announcements from school');
    await l.waitForTimeout(300);
    await shot(l, 'linda-09-channel-name-slug');
    await tap(c, dlg.getByRole('button', { name: /Create channel/ }));
    await l.waitForTimeout(1500);
    await shot(l, 'linda-10-announcement-channel');
    c.notes.push('sidebar: ' + (await l.locator('nav, aside').allInnerTexts()).join(' / ').replace(/\s+/g, ' ').slice(0, 400));
  });

  await task('Linda', 'L4 make announcements read-only for parents', async (c) => {
    // Linda looks for a gear/"settings" next to the channel name first (hover), then the header.
    const row = l.getByRole('button', { name: /announcements-from-school/ }).first();
    await row.hover();
    await l.waitForTimeout(400);
    await shot(l, 'linda-11-hover-channel');
    const gear = l.getByRole('button', { name: /Edit channel|Channel settings/ });
    if (await isVis(gear, 800)) { await tap(c, gear); c.notes.push('found gear on hover'); } else {
      c.notes.push('no gear on hover; tries header "More options"');
      const more = l.getByRole('button', { name: 'More options' });
      if (await isVis(more, 1000)) {
        await tap(c, more); await l.waitForTimeout(500); await shot(l, 'linda-12-header-more');
        c.notes.push('more menu: ' + (await body(l)).slice(-300));
        await l.keyboard.press('Escape');
      }
      c.notes.push('finally right-clicks the channel (she would not know to)');
      c.clicks += 1; await row.click({ button: 'right' });
      await l.waitForTimeout(400); await shot(l, 'linda-13-channel-contextmenu');
      await tap(c, l.getByRole('menuitem', { name: 'Edit channel' }).or(l.getByText('Edit channel')));
    }
    await l.waitForTimeout(800);
    await shot(l, 'linda-14-channel-settings');
    const cdlg = l.locator('[role=dialog]').last();
    c.notes.push('channel settings has Permissions: ' + /Permission/i.test(await cdlg.innerText()));
    await tap(c, cdlg.getByRole('button', { name: 'Cancel' }));
    // Only path: Server settings > Channel permissions
    await tap(c, l.getByText(serverName).first());
    await tap(c, l.getByRole('menuitem', { name: 'Server settings' }).or(l.getByRole('button', { name: 'Server settings' })));
    const dlg = l.getByRole('dialog', { name: 'Server settings' });
    await tap(c, dlg.getByRole('button', { name: /Channel permissions/ }));
    await l.waitForTimeout(800);
    await shot(l, 'linda-15-channel-permissions');
    const chSel = dlg.locator('select').first();
    const opt = (await chSel.locator('option').allInnerTexts()).find((o) => /announcements/.test(o));
    c.clicks += 1; await chSel.selectOption({ label: opt });
    c.notes.push('applies-to default: ' + (await dlg.locator('select').nth(1).locator('option:checked').innerText()));
    await l.waitForTimeout(500);
    const grp = dlg.getByRole('radiogroup', { name: 'Send messages', exact: true });
    await grp.scrollIntoViewIfNeeded();
    await shot(l, 'linda-16a-find-send');
    const bb = await grp.getByRole('radio', { name: 'Deny' }).boundingBox();
    c.notes.push('deny button size ' + JSON.stringify(bb));
    await tap(c, grp.getByRole('radio', { name: 'Deny' }));
    await l.waitForTimeout(500);
    await shot(l, 'linda-16-deny-send');
    const save = l.getByRole('button', { name: /^Save/ });
    if (await isVis(save, 1500)) { await tap(c, save); await l.waitForTimeout(800); await shot(l, 'linda-17-saved'); } else c.notes.push('no Save button');
    await tap(c, dlg.getByRole('button', { name: /close/i }).or(dlg.getByLabel('Close')));
    await l.waitForTimeout(500);
  });

  await task('Linda', 'L5 post the group rules and pin them', async (c) => {
    await tap(c, l.getByRole('button', { name: 'general', exact: true }));
    const box = composer(l);
    await tap(c, box);
    await box.fill('Group rules: 1) Be kind 2) No selling 3) School matters only 4) Contact the office for urgent issues');
    await box.press('Enter');
    await l.waitForTimeout(1200);
    const msg = l.locator('[id^="message-"]').filter({ hasText: 'Group rules' }).first();
    await msg.hover();
    await l.waitForTimeout(400);
    await shot(l, 'linda-18-hover-toolbar');
    const more = msg.getByRole('button', { name: /More/ });
    if (await isVis(more, 1000)) { await tap(c, more); await l.waitForTimeout(500); await shot(l, 'linda-19-more-menu'); }
    const pin = l.getByRole('menuitem', { name: /Pin message/ });
    if (await isVis(pin, 1500)) await tap(c, pin); else { c.clicks += 1; await msg.click({ button: 'right' }); await tap(c, l.getByRole('menuitem', { name: /Pin message/ })); c.notes.push('had to right-click to find Pin'); }
    await l.waitForTimeout(800);
    await shot(l, 'linda-20-pinned-confirm');
    const confirm = l.locator('[role=dialog],[role=alertdialog]').getByRole('button', { name: /^Pin/ });
    if (await isVis(confirm, 800)) await tap(c, confirm);
    await l.waitForTimeout(800);
    await shot(l, 'linda-21-after-pin');
  });

  // A parent joins
  const P = await newCtx(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'en-GB' });
  const p = P.page;
  await task('Linda', 'L6 parent joins via link and tries to post in announcements', async (c) => {
    if (!inviteUrl) {
      const r = await api(l, 'GET', '/api/users/@me/servers').catch(() => null);
      c.notes.push('no invite captured ' + JSON.stringify(r?.status));
    }
    await p.goto(inviteUrl);
    await tap(c, p.getByRole('button', { name: 'Sign up' }));
    await p.getByLabel(/Username/).fill(`dave_${RUN}`);
    await p.getByLabel(/^Password/).fill(PW);
    await tap(c, p.locator('form button[type=submit]'));
    const accept = p.getByRole('button', { name: /Accept invite/ });
    if (await isVis(accept, 10000)) await tap(c, accept);
    await p.waitForTimeout(2000);
    await shot(p, 'linda-22-parent-landing');
    await tap(c, p.getByText(/announcements-from-school/));
    await p.waitForTimeout(1500);
    await shot(p, 'linda-23-parent-in-announcements');
    const box = composer(p);
    const disabled = await box.isDisabled().catch(() => true);
    c.notes.push('parent composer disabled in announcements: ' + disabled + ' placeholder=' + (await box.getAttribute('placeholder').catch(() => '')));
    if (!disabled) {
      await box.fill('Does anyone know what time pickup is?');
      await box.press('Enter');
      await p.waitForTimeout(1500);
      await shot(p, 'linda-24-parent-posted');
      c.notes.push('after send: ' + (await body(p)).slice(-250));
    }
    await p.getByRole('button', { name: /Show channels/ }).click().catch(() => {});
    await tap(c, p.getByRole('button', { name: 'general', exact: true }));
    await p.waitForTimeout(800);
    await composer(p).fill('Hi all, Dave here (Oliver’s dad). What time is pickup on Friday?');
    await composer(p).press('Enter');
    for (let i = 0; i < 4; i += 1) { await composer(p).fill(`chatty message ${i} lol`); await composer(p).press('Enter'); await p.waitForTimeout(300); }
  });

  await task('Linda', 'L7 see who has read the announcement ("read receipts")', async (c) => {
    await tap(c, l.getByRole('button', { name: /announcements-from-school/ }));
    const box = composer(l);
    await tap(c, box);
    await box.fill('Reminder: school trip letters due Friday. Please reply ✅ when you have read this.');
    await box.press('Enter');
    await l.waitForTimeout(1500);
    const msg = l.locator('[id^="message-"]').filter({ hasText: 'school trip' }).first();
    await msg.hover();
    await l.waitForTimeout(300);
    c.clicks += 1; await msg.click({ button: 'right' });
    await l.waitForTimeout(500);
    await shot(l, 'linda-25-looking-for-seen-by');
    const menu = (await l.locator('[role=menu]').allInnerTexts()).join('|').replace(/\s+/g, ' ');
    c.notes.push('context menu: ' + menu.slice(0, 400));
    c.notes.push('has seen/read-by: ' + /seen|read by|viewed/i.test(menu));
    await l.keyboard.press('Escape');
    throw new Error('no read receipts / "seen by" anywhere');
  });

  await task('Linda', 'L8 mute the chatty #general channel', async (c) => {
    await l.waitForTimeout(1000);
    await shot(l, 'linda-26-unread-general');
    await tap(c, l.getByRole('button', { name: 'general', exact: true }));
    await tap(c, l.getByRole('button', { name: 'Notification settings' }));
    await l.waitForTimeout(600);
    await shot(l, 'linda-27-notif-popover');
    c.notes.push('popover: ' + (await body(l)).slice(-400));
    const mute = l.getByRole('menuitem', { name: /Mute channel/ }).or(l.getByRole('button', { name: /Mute channel/ })).or(l.getByText('Mute channel'));
    await tap(c, mute);
    await l.waitForTimeout(600);
    if (!(await isVis(l.getByText('Until I turn it back on'), 800))) {
      c.notes.push('clicking the words "Mute channel" does nothing; only the small switch works');
      await tap(c, l.getByRole('switch', { name: 'Mute channel' }));
      await l.waitForTimeout(500);
    }
    await shot(l, 'linda-28-mute-duration');
    const forever = l.getByText('Until I turn it back on');
    if (await isVis(forever, 1500)) await tap(c, forever);
    await l.waitForTimeout(800);
    await l.keyboard.press('Escape');
    await shot(l, 'linda-29-muted-sidebar');
  });

  await task('Linda', 'L9 find last week\'s "trip letters" message by searching', async (c) => {
    const s = l.getByPlaceholder('Search').first();
    await tap(c, s);
    await s.fill('trip');
    await s.press('Enter');
    await l.waitForTimeout(1500);
    await shot(l, 'linda-30-search');
    c.notes.push('found: ' + ((await l.getByText(/school trip/).count()) >= 2));
  });

  await task('Linda', 'L10 make a co-admin (Dave) a moderator', async (c) => {
    await tap(c, l.getByText(serverName).first());
    await l.waitForTimeout(400);
    await shot(l, 'linda-31-server-menu');
    await tap(c, l.getByRole('menuitem', { name: 'Server settings' }).or(l.getByRole('button', { name: 'Server settings' })));
    await l.waitForTimeout(800);
    await shot(l, 'linda-32-server-settings');
    const dlg = l.getByRole('dialog', { name: 'Server settings' });
    c.notes.push('nav: ' + (await dlg.innerText()).replace(/\s+/g, ' ').slice(0, 500));
    await tap(c, dlg.getByRole('button', { name: /^Roles$/ }));
    await l.waitForTimeout(800);
    await shot(l, 'linda-33-roles');
    await tap(c, dlg.getByRole('button', { name: /Create role/ }));
    await l.waitForTimeout(800);
    await shot(l, 'linda-34-new-role');
    c.notes.push('role editor: ' + (await dlg.innerText()).replace(/\s+/g, ' ').slice(0, 600));
    await l.keyboard.press('Escape');
    await l.waitForTimeout(400);
    if (await isVis(dlg, 500)) await dlg.getByLabel('Close').first().click().catch(() => {});
  });

  await task('Linda', 'L11 remove a spammer (kick) from member list', async (c) => {
    const ml = l.locator('aside[aria-label*="member" i]');
    const x = l.getByRole('button', { name: 'Close' });
    if (await l.getByText(/Results for/).count()) await x.first().click().catch(() => {});
    if (!(await isVis(ml, 1000))) await tap(c, l.getByTitle('Member list'));
    await l.waitForTimeout(600);
    await shot(l, 'linda-35-member-list');
    c.clicks += 1; await ml.getByText(`dave_${RUN}`).first().click({ button: 'right' }).catch(async () => { await ml.getByText(/dave/).first().click({ button: 'right' }); });
    await l.waitForTimeout(500);
    await shot(l, 'linda-36-member-menu');
    c.notes.push('member menu: ' + (await l.locator('[role=menu]').allInnerTexts()).join('|').replace(/\s+/g, ' ').slice(0, 300));
    await l.keyboard.press('Escape');
  });

  console.log('Linda page errors', l.errors, p.errors);
  await Promise.all([L.context.close(), P.context.close()]);
};

// ---------------------------------------------------------------------------
//  Rosa — iPad 820x1180, pt-BR, touch. Bakery customer community.
// ---------------------------------------------------------------------------
globalThis.rosa = async function rosa(browser) {
  const ipad = { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
  const R = await newCtx(browser, ipad);
  const r = R.page;
  const serverName = 'Padaria da Rosa';
  let inviteUrl;
  await task('Rosa', 'R1 register (pt-BR auto-detected?)', async (c) => {
    await r.goto(BASE + '/');
    await r.waitForTimeout(1500);
    await shot(r, 'rosa-01-login');
    c.notes.push('login text: ' + (await body(r)).slice(0, 200));
    await tap(c, r.getByRole('button', { name: /Cadastrar-se/ }));
    await r.waitForTimeout(500);
    await shot(r, 'rosa-02-register');
    c.clicks += 3;
    await r.getByLabel(/Nome de usuário/i).fill(`rosa_padaria_${RUN}`);
    await r.getByLabel(/Nome exibido/i).fill('Rosa — Padaria');
    await r.getByLabel(/^Senha/i).fill(PW);
    await tap(c, r.locator('form button[type=submit]'));
    await vis(r.getByRole('navigation').first(), 20000);
    await r.waitForTimeout(1500);
    await shot(r, 'rosa-03-home');
  });
  await task('Rosa', 'R2 create the bakery community server', async (c) => {
    const btn = r.getByRole('button', { name: /Criar (um )?servidor/ });
    if (await isVis(btn, 1500)) await tap(c, btn); else await tap(c, r.getByRole('button', { name: /Adicionar um servidor/ }));
    await r.waitForTimeout(600);
    await shot(r, 'rosa-04-create-modal');
    await tap(c, r.getByRole('button', { name: /Criar o meu/ }));
    c.clicks += 1; await r.getByPlaceholder(/QG da Galera/).fill(serverName);
    await tap(c, r.getByRole('button', { name: /^Criar$/ }));
    await vis(r.getByText(serverName));
    const offer = r.locator('[role=dialog]').last();
    if (await isVis(r.locator('#invite-link'), 4000)) {
      await r.waitForFunction(() => /\/invite\//.test(document.getElementById('invite-link')?.value ?? ''), null, { timeout: 8000 }).catch(() => {});
      await offer.locator('select').first().selectOption({ index: 6 }).catch(() => {});
      await r.waitForTimeout(1200);
      inviteUrl = await r.locator('#invite-link').inputValue();
      await shot(r, 'rosa-05-invite');
      c.notes.push('invite dialog: ' + (await offer.innerText()).replace(/\s+/g, ' ').slice(0, 300));
      await r.keyboard.press('Escape');
    }
    await r.waitForTimeout(800);
    await shot(r, 'rosa-06-server');
    c.notes.push('screen: ' + (await body(r)).slice(0, 300));
  });
  await task('Rosa', 'R3 create #pedidos (announcements) and #suporte', async (c) => {
    for (const [name, type] of [['Pedidos e Encomendas', 'Anúncios'], ['Suporte', null]]) {
      const add = r.getByRole('button', { name: /Criar canal de texto|Criar canal/ }).or(r.getByTitle(/Criar canal/));
      if (!(await isVis(add, 1500))) { const m = r.getByRole('button', { name: /Mostrar canais/ }); if (await isVis(m, 1000)) await tap(c, m); }
      await tap(c, add);
      const dlg = r.locator('[role=dialog]').last();
      if (type) await tap(c, dlg.getByText(type, { exact: true }));
      c.clicks += 1; await dlg.getByPlaceholder('novo-canal').fill(name);
      await shot(r, `rosa-07-create-${type ? 'pedidos' : 'suporte'}`);
      await tap(c, dlg.getByRole('button', { name: /Criar canal/ }));
      await r.waitForTimeout(1200);
    }
    await shot(r, 'rosa-08-channels');
  });
  await task('Rosa', 'R4 set up spam protection (block links / spam)', async (c) => {
    const m = r.getByRole('button', { name: /Mostrar canais/ }); if (await isVis(m, 800)) await tap(c, m);
    await tap(c, r.getByText(serverName).first());
    await r.waitForTimeout(500);
    await shot(r, 'rosa-09-server-menu');
    c.notes.push('menu: ' + (await r.locator('[role=menu]').allInnerTexts()).join('|').replace(/\s+/g, ' ').slice(0, 300));
    await tap(c, r.getByRole('menuitem', { name: /Configurações do servidor/ }).or(r.getByRole('button', { name: /Configurações do servidor/ })));
    await r.waitForTimeout(800);
    await shot(r, 'rosa-10-server-settings');
    const dlg = r.getByRole('dialog').last();
    c.notes.push('settings nav: ' + (await dlg.innerText()).replace(/\s+/g, ' ').slice(0, 400));
    await tap(c, dlg.getByRole('button', { name: /^AutoMod$/ }));
    await r.waitForTimeout(800);
    await shot(r, 'rosa-11-automod');
    c.notes.push('automod: ' + (await dlg.innerText()).replace(/\s+/g, ' ').slice(0, 500));
    await tap(c, dlg.getByRole('button', { name: /Criar regra/ }));
    await r.waitForTimeout(600);
    await shot(r, 'rosa-12-automod-new');
    c.notes.push('rule types: ' + (await dlg.locator('select').first().locator('option').allInnerTexts()).join(', '));
    c.clicks += 1; await dlg.locator('select').first().selectOption({ label: 'Links' });
    await r.waitForTimeout(400);
    await shot(r, 'rosa-13-automod-links');
    const save = r.getByRole('button', { name: /Salvar|Criar regra|Salvar alterações/ }).last();
    await tap(c, save);
    await r.waitForTimeout(1000);
    await shot(r, 'rosa-14-automod-saved');
    c.notes.push('after save: ' + (await dlg.innerText()).replace(/\s+/g, ' ').slice(0, 300));
    await tap(c, dlg.getByRole('button', { name: /Visão geral/ }));
    await r.waitForTimeout(500);
    c.notes.push('overview has verification level: ' + /verifica/i.test(await dlg.innerText()));
    await r.keyboard.press('Escape');
    await r.waitForTimeout(400);
    if (await isVis(dlg, 500)) await dlg.getByLabel(/Fechar/).first().click().catch(() => {});
  });
  const C = await newCtx(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'pt-BR' });
  const cu = C.page;
  await task('Rosa', 'R5 a spammer joins and posts a scam link in #suporte', async (c) => {
    await cu.goto(inviteUrl);
    await cu.getByRole('button', { name: /Cadastrar-se/ }).click();
    await cu.getByLabel(/Nome de usuário/i).fill(`promo_pix_${RUN}`);
    await cu.getByLabel(/^Senha/i).fill(PW);
    for (let i = 0; i < 6; i += 1) {
      await cu.locator('form button[type=submit]').click();
      await cu.waitForTimeout(2500);
      if (!(await cu.getByText(/rápido demais/).count())) break;
      c.notes.push('rate-limited on sign-up ("rápido demais"), waiting');
      await cu.waitForTimeout(20000);
    }
    const acc = cu.getByRole('button', { name: /Aceitar/ });
    if (await isVis(acc, 10000)) await acc.first().click();
    await cu.waitForTimeout(2000);
    await shot(cu, 'rosa-15-customer-landing');
    c.notes.push('customer lands on: ' + (await body(cu)).slice(0, 250));
    const sup = cu.getByRole('button', { name: 'suporte', exact: true }).first();
    if (!(await isVis(sup, 1000))) await cu.getByRole('button', { name: /Mostrar canais/ }).click();
    await sup.click();
    await composer(cu).fill('GANHE R$500 no PIX agora!!! https://bit.ly/pix-gratis');
    await composer(cu).press('Enter');
    await cu.waitForTimeout(1500);
    await shot(cu, 'rosa-16-spam-attempt');
    c.notes.push('spammer sees: ' + (await body(cu)).slice(-200));
    await composer(cu).fill('Oi, vocês entregam no Centro? Quero 2 bolos.');
    await composer(cu).press('Enter');
    await cu.waitForTimeout(800);
  });
  await task('Rosa', 'R6 Rosa bans the spammer', async (c) => {
    await r.waitForTimeout(1000);
    const ml = r.locator('aside[aria-label*="member" i]');
    if (!(await isVis(ml, 1000))) await tap(c, r.getByRole('button', { name: /Lista de membros/ }));
    await r.waitForTimeout(700);
    await shot(r, 'rosa-17-members');
    const who = r.getByText(new RegExp(`^promo_pix_${RUN}$`)).last();
    c.clicks += 1; await who.dispatchEvent('contextmenu');
    await r.waitForTimeout(600);
    if (!(await isVis(r.getByRole('menu'), 800))) { c.notes.push('long-press does not open a menu on iPad; used right-click'); await who.click({ button: 'right' }); }
    await r.waitForTimeout(500);
    await shot(r, 'rosa-18-member-menu');
    c.notes.push('menu: ' + (await r.locator('[role=menu]').allInnerTexts()).join('|').replace(/\s+/g, ' ').slice(0, 300));
    await tap(c, r.getByRole('menuitem', { name: /Banir/ }));
    await r.waitForTimeout(600);
    await shot(r, 'rosa-19-ban-confirm');
    const conf = r.locator('[role=dialog],[role=alertdialog]').last().getByRole('button', { name: /Banir/ });
    await tap(c, conf);
    await r.waitForTimeout(800);
    await shot(r, 'rosa-20-banned');
  });
  await task('Rosa', 'R7 post an order announcement with photo in #pedidos', async (c) => {
    await r.keyboard.press('Escape');
    if (await isVis(r.locator('aside[aria-label*="membro" i], aside[aria-label*="member" i]'), 500)) {
      c.notes.push('member panel overlay stays open after Escape; taps the dimmed area');
      c.clicks += 1; await r.mouse.click(300, 600);
      await r.waitForTimeout(500);
      if (await isVis(r.locator('aside[aria-label*="membro" i], aside[aria-label*="member" i]'), 500)) {
        c.notes.push('tapping the dimmed backdrop does not close it either');
        await shot(r, 'rosa-20b-stuck-overlay');
        c.clicks += 1; await r.getByRole('button', { name: /Lista de membros/ }).first().click({ force: true }).catch(() => {});
      }
    }
    await r.waitForTimeout(400);
    const m = r.getByRole('button', { name: /Mostrar canais/ }); if (await isVis(m, 800)) await tap(c, m);
    await tap(c, r.getByRole('button', { name: /pedidos-e-encomendas/ }).first());
    await r.locator('input[type="file"]').first().setInputFiles({ name: 'bolo-de-fuba.png', mimeType: 'image/png', buffer: makePng(1200, 900, [240, 200, 120]) });
    c.clicks += 2;
    await r.waitForTimeout(700);
    await shot(r, 'rosa-21-attachment-preview');
    await composer(r).fill('🍰 Encomendas de Natal abertas! Bolo de fubá R$35. Peça até 20/12 pelo #suporte.');
    await composer(r).press('Enter');
    await r.waitForTimeout(2500);
    await shot(r, 'rosa-22-announcement-posted');
  });
  await task('Rosa', 'R8 privacy: stop customers DMing her personal account', async (c) => {
    const us = r.getByRole('button', { name: /Configurações de usuário/ });
    if (!(await isVis(us, 1000))) { const m = r.getByRole('button', { name: /Mostrar canais/ }); if (await isVis(m, 800)) await tap(c, m); }
    await tap(c, r.getByRole('button', { name: /Configurações de usuário/ }));
    await r.waitForTimeout(700);
    await tap(c, r.getByRole('button', { name: /Privacidade e segurança/ }).first());
    await r.waitForTimeout(800);
    await shot(r, 'rosa-23-privacy');
    c.notes.push('privacy: ' + (await body(r)).slice(0, 600));
    await r.mouse.wheel(0, 900); await r.waitForTimeout(500);
    await shot(r, 'rosa-24-privacy-2');
    await r.keyboard.press('Escape');
  });
  console.log('Rosa page errors', r.errors, cu.errors);
  await Promise.all([R.context.close(), C.context.close()]);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
try {
  if (which === 'somchai' || which === 'all') await somchai(browser);
  if ((which === 'linda' || which === 'all') && globalThis.linda) await globalThis.linda(browser);
  if ((which === 'rosa' || which === 'all') && globalThis.rosa) await globalThis.rosa(browser);
} finally {
  await browser.close();
  fs.writeFileSync(path.join(SHOTS, `persona-older-nontech-log-${which}.json`), JSON.stringify(log, null, 2));
}
