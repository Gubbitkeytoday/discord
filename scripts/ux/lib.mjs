// Shared helpers for UX persona scenarios (youth-gamers panel).
import fs from 'node:fs';
import path from 'node:path';

export const PORT = Number(process.env.UX_PORT || 7010);
export const BASE = `http://localhost:${PORT}`;
export const SHOTS = process.env.UX_SHOTS
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';
export const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
export const PASSWORD = 'correct-horse-battery-9';
fs.mkdirSync(SHOTS, { recursive: true });

export const DEVICES = {
  iphoneSE: {
    viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  },
  pixel7: {
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'
  },
  desktop1080: { viewport: { width: 1920, height: 1080 } },
  laptop768: { viewport: { width: 1366, height: 768 } }
};

/** A tiny instrumented user. Counts clicks/taps and records timings + notes. */
export async function newPersona(browser, who, opts = {}) {
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write', 'microphone', 'camera'],
    ...opts
  });
  await context.route((u) => !u.href.startsWith(BASE) && /^https?:/.test(u.href), (r) => r.abort());
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  const p = { who, context, page, errors: [], clicks: 0, shotN: 0 };
  page.on('pageerror', (e) => p.errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errors.push(m.text().slice(0, 300)); });
  p.shot = async (name, o = {}) => {
    const f = path.join(SHOTS, `persona-youth-gamers-${who}-${String(++p.shotN).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: f, ...o }).catch(() => {});
    return f;
  };
  p.click = async (loc, o) => { p.clicks += 1; await loc.first().click(o); };
  return p;
}

export async function throttle(page, { cpu = 1, net = null } = {}) {
  const cdp = await page.context().newCDPSession(page);
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  if (net) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...net });
  return cdp;
}
export const FAST3G = { latency: 562, downloadThroughput: (1.6 * 1024 * 1024) / 8 * 0.9, uploadThroughput: (750 * 1024) / 8 * 0.9 };

export const results = [];
export async function task(persona, name, fn) {
  const t0 = Date.now();
  const c0 = persona.clicks;
  let ok = true; let note = '';
  try { note = (await fn()) ?? ''; } catch (e) {
    ok = false; note = String(e.message ?? e).split('\n')[0].slice(0, 240);
    await persona.shot('FAIL-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40));
  }
  const r = { who: persona.who, name, ok, s: ((Date.now() - t0) / 1000).toFixed(1), clicks: persona.clicks - c0, note };
  results.push(r);
  console.log(`${ok ? 'PASS' : 'FAIL'} [${persona.who}] ${name} ${r.s}s ${r.clicks} clicks ${note}`);
  return ok;
}

export const composer = (page) => page.locator('textarea[aria-label^="Message"], textarea[aria-label^="ส่งข้อความ"], textarea[aria-label^="Nhắn"], [role="textbox"]').first();
export const msgRow = (page, text) => page.locator('[id^="message-"]').filter({ hasText: text });
