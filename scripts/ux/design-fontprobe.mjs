// Which font files actually paint the glyphs (CDP CSS.getPlatformFontsForNode),
// per UI language. Complements design-shots.mjs.
//   UX_PORT=8391 node scripts/ux/design-fontprobe.mjs
import { chromium } from 'playwright-core';
import { BASE, CHROMIUM, PASSWORD } from './lib.mjs';

const RUN = Date.now().toString(36).slice(-5);
const browser = await chromium.launch({ executablePath: CHROMIUM });

async function probe(locale) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale });
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.locator('form button[type=button], button').filter({ hasText: /Sign up|สมัคร|登録|註冊|注册|가입|Registr|Зарег|Rejestr/i }).first().click();
  await page.locator('input[autocomplete="username"], input[name="username"]').first().fill(`probe_${locale.replace(/\W/g, '')}_${RUN}`);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await page.locator('nav').first().waitFor();
  await page.waitForTimeout(1200);
  const server = await page.evaluate(async () => {
    const r = await fetch('/api/servers', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Font probe' }) });
    return r.json();
  });
  const detail = await page.evaluate(async (id) => (await fetch(`/api/servers/${id}`, { credentials: 'same-origin' })).json(), server.id);
  const channel = (detail.channels ?? []).find((c) => c.type === 'text');
  await page.evaluate(async (id) => {
    await fetch('/api/messages', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: id, content: '直骨次 会議 สวัสดีครับ ก๋วยเตี๋ยว Hello Привет' }) });
  }, channel.id);
  await page.goto(`${BASE}/channels/${server.id}/${channel.id}`);
  await page.locator('[id^="message-"]').first().waitFor();
  await page.waitForTimeout(1500);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const pick = async (selector) => {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) return 'n/a';
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts.map((f) => `${f.familyName}(${f.glyphCount})`).join(', ');
  };
  const lang = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.includes('会議')) { n.parentElement.setAttribute('data-probe', '1'); break; }
    }
    return document.documentElement.lang;
  });
  const body = await pick('[data-probe]');
  const chrome = await pick('nav[aria-label] + * h2, header h1, h1, h2');
  console.log(`${locale} (html lang=${lang})\n  message: ${body}\n  chrome:  ${chrome}`);
  await ctx.close();
}

try {
  for (const locale of ['en-US', 'th-TH', 'ja-JP', 'zh-TW', 'ko-KR']) await probe(locale);
} catch (e) {
  console.error('FAILED', e);
} finally {
  await browser.close();
}
