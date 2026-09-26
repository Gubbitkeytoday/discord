// Screenshots of every base theme (and saturation 0 / high contrast) for the
// design polish round.   UX_PORT=8391 node scripts/ux/design-themes.mjs
import { chromium } from 'playwright-core';
import path from 'node:path';
import { BASE, SHOTS, CHROMIUM, PASSWORD } from './lib.mjs';

const RUN = Date.now().toString(36).slice(-5);
const out = (name) => path.join(SHOTS, `polish-design-${name}.png`);
const browser = await chromium.launch({ executablePath: CHROMIUM });

const call = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => null);
}, { method, url, body });

try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'th-TH' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: /Sign up|สมัคร/ }).click();
  await page.locator('input[autocomplete="username"], input[name="username"]').first().fill(`theme_${RUN}`);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await page.locator('nav').first().waitFor();
  const server = await call(page, 'POST', '/api/servers', { name: 'ชมรมหนังสือ Book Club' });
  const detail = await call(page, 'GET', `/api/servers/${server.id}`);
  const channel = (detail.channels ?? []).find((c) => c.type === 'text');
  for (const content of ['สวัสดีทุกคน ยินดีต้อนรับ **ตัวหนา** และลิงก์ https://example.com', 'Hello from the design pass — `code` and a mention @everyone']) {
    await call(page, 'POST', '/api/messages', { channel_id: channel.id, content });
  }
  const variants = [
    ['dark', {}], ['light', {}], ['ash', {}], ['onyx', {}],
    ['dark-sat0', { a11y: { saturation: 0 } }],
    ['light-hc', { a11y: { highContrast: true, saturation: 100 } }]
  ];
  for (const [name, extra] of variants) {
    const theme = name.split('-')[0];
    await call(page, 'PATCH', '/api/settings/preferences/appearance', { theme });
    await call(page, 'PATCH', '/api/settings/preferences/accessibility', { saturation: 100, highContrast: false, ...(extra.a11y ?? {}) });
    await page.goto(`${BASE}/channels/${server.id}/${channel.id}`);
    await page.locator('[id^="message-"]').first().waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: out(`theme-${name}-1366`) });
  }
  await call(page, 'PATCH', '/api/settings/preferences/accessibility', { saturation: 100, highContrast: false });
  await call(page, 'PATCH', '/api/settings/preferences/appearance', { theme: 'system', systemDarkTheme: 'onyx' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await page.locator('[id^="message-"]').first().waitFor();
  const resolved = await page.evaluate(() => document.documentElement.dataset.theme);
  console.log('system + dark OS + systemDarkTheme=onyx →', resolved);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'th-TH', colorScheme: 'light' });
  await phone.addCookies(await ctx.cookies());
  const p = await phone.newPage();
  await call(page, 'PATCH', '/api/settings/preferences/appearance', { theme: 'light' });
  await p.goto(`${BASE}/channels/${server.id}/${channel.id}`);
  await p.waitForTimeout(2000);
  await p.screenshot({ path: out('theme-light-390') });
  console.log('page errors:', errors.length ? errors : 'none');
} catch (e) {
  console.error('FAILED', e);
} finally {
  await browser.close();
}
