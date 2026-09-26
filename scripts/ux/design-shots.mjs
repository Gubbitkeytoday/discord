// Visual check for the design polish round: server rail badges, status
// shapes, notification popover, inbox, settings (Accessibility, Language,
// Text & Images), 200% app zoom, dark + light, desktop + phone.
//
//   UX_PORT=8391 node scripts/ux/design-shots.mjs
//
// Expects a server already running on UX_PORT (SERVE_STATIC=1, fresh DB).
import { chromium } from 'playwright-core';
import path from 'node:path';
import { BASE, SHOTS, CHROMIUM, PASSWORD } from './lib.mjs';

const RUN = Date.now().toString(36).slice(-5);
const out = (name) => path.join(SHOTS, `polish-design-${name}.png`);
const log = (...a) => console.log(...a);

async function api(page, method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
  }, { method, url, body });
}

async function register(page, username) {
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: /Sign up|สมัคร/ }).click();
  await page.getByLabel(/Username|ชื่อผู้ใช้/).fill(username);
  await page.getByLabel(/^Password|^รหัสผ่าน/).fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await page.getByRole('navigation', { name: /Servers|เซิร์ฟเวอร์/ }).waitFor({ timeout: 15000 });
}

const browser = await chromium.launch({ executablePath: CHROMIUM });
const errors = [];
try {
  // --- splash on a slow network (no JS yet) ---------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' });
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 2000, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 });
    p.goto(BASE + '/').catch(() => {});
    await p.waitForTimeout(3500);
    await p.screenshot({ path: out('splash-390-light') });
    await ctx.close();
  }

  const A = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark', locale: 'en-US' });
  const B = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'th-TH' });
  const a = await A.newPage();
  const b = await B.newPage();
  a.on('pageerror', (e) => errors.push('A ' + e.message));
  b.on('pageerror', (e) => errors.push('B ' + e.message));

  await register(a, `alice_${RUN}`);
  await register(b, `somchai_${RUN}`);

  // Two servers owned by alice; bob joins both.
  const s1 = (await api(a, 'POST', '/api/servers', { name: 'Book Club' })).body;
  const s2 = (await api(a, 'POST', '/api/servers', { name: 'ไรเดอร์ สายไหม' })).body;
  const s3 = (await api(a, 'POST', '/api/servers', { name: 'บ้านเรา 🏠' })).body;
  log('servers', s1?.id, s2?.id, s3?.id);
  for (const s of [s1, s2, s3]) {
    const inv = (await api(a, 'POST', `/api/servers/${s.id}/invites`, { maxAge: 0 })).body;
    const r = await api(b, 'POST', `/api/invites/${inv.code}/accept`);
    log('join', s.name, r.status);
  }
  const chans = async (page, s) => { const r = (await api(page, "GET", `/api/servers/${s.id}`)).body; return r.channels ?? r.server?.channels ?? []; };
  const c2 = (await chans(b, s2)).find?.((c) => c.type === 'text');
  const c3 = (await chans(b, s3)).find?.((c) => c.type === 'text');
  log('channels', c2?.id, c3?.id);

  await a.reload();
  await a.getByRole('navigation', { name: 'Servers' }).waitFor();
  // Alice looks at server 1 while somchai pings her in servers 2 and 3.
  await a.getByRole('button', { name: /^Book Club/ }).click();
  await a.waitForTimeout(800);
  const me = (await api(a, 'GET', '/api/auth/me')).body;
  const aliceId = me?.id ?? me?.user?.id;
  for (let i = 0; i < 3; i += 1) {
    await api(b, 'POST', '/api/messages', { channel_id: c2.id, content: `<@${aliceId}> ช่วยดูหน่อย ${i}` });
  }
  await api(b, 'POST', '/api/messages', { channel_id: c3.id, content: 'สวัสดีครับ 😀 こんにちは 你好 안녕하세요' });
  await a.waitForTimeout(1500);
  await a.screenshot({ path: out('rail-badges-1366-dark') });
  const railNames = await a.getByRole('navigation', { name: 'Servers' }).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  log('rail names:', JSON.stringify(railNames));

  // Font probe: what font family is on a message?
  await a.getByRole('button', { name: /^บ้านเรา/ }).click();
  await a.waitForTimeout(1000);
  const fam = await a.evaluate(() => getComputedStyle(document.querySelector('[id^="message-"]') ?? document.body).fontFamily);
  log('message font-family:', fam.slice(0, 80));
  await a.screenshot({ path: out('chat-1366-dark') });

  // Keyboard roving in the rail.
  await a.getByRole('button', { name: /^Direct messages/i }).focus();
  await a.keyboard.press('ArrowDown');
  const focused = await a.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  log('ArrowDown focus →', focused);
  // Keyboard reorder: Ctrl+Shift+↓ moves the focused server one place down.
  await a.keyboard.press('Control+Shift+ArrowDown');
  await a.waitForTimeout(500);
  const order = await a.getByRole('navigation', { name: 'Servers' }).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  const stillFocused = await a.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  log('after Ctrl+Shift+Down:', JSON.stringify(order), 'focus:', stillFocused);

  // Server context menu (notification popover) with Move up/down.
  await a.getByRole('button', { name: /^ไรเดอร์/ }).click({ button: 'right' });
  await a.waitForTimeout(400);
  await a.screenshot({ path: out('server-menu-1366-dark') });
  await a.keyboard.press('Escape');

  // Status menu.
  const avatarBtn = a.locator('div.h-14 > button[aria-haspopup]').first();
  await avatarBtn.click().catch(() => {});
  await a.waitForTimeout(300);
  await a.screenshot({ path: out('status-menu-1366-dark') });
  await a.keyboard.press('Escape');

  // Settings pages.
  await a.keyboard.press('Control+Comma');
  await a.waitForTimeout(600);
  for (const [tab, name] of [['Accessibility', 'settings-a11y'], ['Language', 'settings-language'], ['Text & Images', 'settings-chat']]) {
    await a.getByRole('button', { name: tab, exact: true }).click();
    await a.waitForTimeout(400);
    await a.screenshot({ path: out(`${name}-1366-dark`) });
  }
  // Light theme via settings.
  await a.getByRole('button', { name: 'Appearance', exact: true }).click();
  await a.getByRole('radio', { name: /Light/ }).click();
  await a.waitForTimeout(400);
  await a.screenshot({ path: out('settings-appearance-1366-light') });
  // 200% app zoom
  await a.getByRole('button', { name: 'Accessibility', exact: true }).click();
  await a.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('antigravity.preferences') || '{}');
    return raw;
  });
  await a.keyboard.press('Escape');
  await a.waitForTimeout(400);
  await a.screenshot({ path: out('chat-1366-light') });

  await a.evaluate(async () => {
    await fetch('/api/settings/preferences/appearance', { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zoom: 200 }) });
  });
  await a.reload();
  await a.locator('nav').first().waitFor({ state: 'attached' });
  await a.waitForTimeout(1200);
  const below = await a.evaluate(() => document.documentElement.dataset.below);
  log('zoom 200 data-below =', below);
  await a.screenshot({ path: out('zoom200-1366-light') });
  await a.evaluate(async () => {
    await fetch('/api/settings/preferences/appearance', { method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zoom: 100, theme: 'dark' }) });
  });

  // Inbox (bell) for alice.
  // Phone, Thai, light: somchai.
  const P = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', locale: 'th-TH' });
  const p = await P.newPage();
  p.on('pageerror', (e) => errors.push('P ' + e.message));
  await p.goto(BASE + '/');
  const cookies = await B.cookies();
  await P.addCookies(cookies);
  await p.goto(BASE + '/');
  await p.waitForTimeout(2500);
  await p.screenshot({ path: out('phone-390-light-th') });
  const menuBtn = p.locator('button[aria-label*="รายการ"], button[aria-label*="channel list" i]').first();
  await menuBtn.click().catch(() => {});
  await p.waitForTimeout(600);
  await p.screenshot({ path: out('phone-drawer-390-light-th') });
} catch (e) {
  console.error('FAILED', e);
} finally {
  log('page errors:', errors.length ? errors : 'none');
  await browser.close();
}
