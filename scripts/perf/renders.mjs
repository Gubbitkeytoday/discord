#!/usr/bin/env node
// ============================================================================
//  React re-render counts per interaction, without changing app code.
//
//  Builds an UNMINIFIED production bundle (same config, minify: false, so
//  component names survive) into $PERF_OUT/names-dist and serves it with
//  STATIC_DIR. A minimal __REACT_DEVTOOLS_GLOBAL_HOOK__ is installed before
//  React loads; production react-dom reports every commit to it. For each
//  commit the fiber tree is walked the way React DevTools does it: a
//  component "rendered" when it mounted or carries the PerformedWork flag,
//  and a subtree is only entered when its child pointer changed (i.e. React
//  did not bail out of the whole subtree).
//
//  Scenarios (in a channel with PERF_ROWS rows loaded, default 200):
//    - one incoming message (real API post by another user -> socket)
//    - one keystroke in the composer
//    - one typing indicator from another user
//    - one reaction added to a visible message by another user
//  Usage: node scripts/perf/renders.mjs
//  Output: $PERF_OUT/renders.json
// ============================================================================
import path from 'node:path';
import { build, loadConfigFromFile, mergeConfig } from 'vite';
import { chromium } from 'playwright-core';
import { bootServer, seedWorld, BASE, ROOT, OUT, CHROMIUM, cookieFor, sleep, writeJson } from './lib.mjs';

const ROWS = Number(process.env.PERF_ROWS || 200);
const outDir = path.join(OUT, 'names-dist');
const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(ROOT, 'vite.config.js'));
await build(mergeConfig(config, { root: ROOT, configFile: false, logLevel: 'error', build: { outDir, emptyOutDir: true, minify: false, reportCompressedSize: false } }));

const srv = await bootServer({ env: { STATIC_DIR: outDir } });
const world = await seedWorld({ messages: ROWS, channels: 2, authors: 3, imageEvery: 50 });
const browser = await chromium.launch({ executablePath: CHROMIUM });
const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
await context.addCookies([cookieFor(world.viewer)]);
await context.route((u) => !u.href.startsWith(BASE) && /^https?:/.test(u.href), (r) => r.abort());
await context.addInitScript(() => {
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]); // Function, Class, ForwardRef, Memo, SimpleMemo
  const nameOf = (f) => f.type?.displayName || f.type?.name || f.type?.render?.name || f.elementType?.type?.name || f.elementType?.render?.name || (f.tag === 11 ? 'ForwardRef(anonymous: lucide Icon inner)' : 'Anonymous');
  const log = window.__renders = { commits: 0, counts: {} };
  function walk(fiber) {
    for (let f = fiber; f; f = f.sibling) {
      if (COMPONENT_TAGS.has(f.tag) && (f.alternate === null || (f.flags & 1))) {
        const n = nameOf(f); log.counts[n] = (log.counts[n] ?? 0) + 1;
      }
      if (f.child && (f.alternate === null || f.child !== f.alternate.child)) walk(f.child);
    }
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, setStrictMode() {},
    onCommitFiberRoot(_id, root) {
      log.commits += 1;
      const cur = root.current;
      if (cur.alternate && cur.child === cur.alternate.child) return;
      walk(cur.child);
    }
  };
});
const page = await context.newPage();
await page.goto(`${BASE}/channels/${world.serverId}/${world.long.id}`);
const box = page.locator('textarea[aria-label^="Message"]').first();
await box.waitFor({ timeout: 20_000 });
// load the whole channel so row count = ROWS
for (let i = 0; i < 20; i += 1) {
  const n = await page.locator('[id^="message-"]').count();
  if (n >= ROWS) break;
  await page.evaluate(() => { const el = document.querySelector('div.overflow-y-auto.select-text'); el.scrollTop = 0; });
  await sleep(700);
}
await page.evaluate(() => { const el = document.querySelector('div.overflow-y-auto.select-text'); el.scrollTop = el.scrollHeight; });
await sleep(1500);
const rows = await page.locator('[id^="message-"]').count();

const reset = () => page.evaluate(() => { window.__renders.commits = 0; window.__renders.counts = {}; });
const collect = async (label) => {
  await sleep(1200);
  const r = await page.evaluate(() => window.__renders);
  const total = Object.values(r.counts).reduce((s, x) => s + x, 0);
  const top = Object.entries(r.counts).sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`${label}: ${r.commits} commits, ${total} component renders; top:`, top.slice(0, 12).map(([k, v]) => `${k}×${v}`).join(', '));
  return { label, commits: r.commits, componentRenders: total, distinctComponents: Object.keys(r.counts).length, top };
};
const out = { rows, scenarios: [] };
const author = world.authors[0];
const msgs = await world.viewer.get(`/api/messages/${world.long.id}?limit=3`);

await reset();
await author.post('/api/messages', { channel_id: world.long.id, content: 'render count probe' });
await page.getByText('render count probe').first().waitFor();
out.scenarios.push(await collect('1 incoming message'));

await box.click(); await sleep(300); await reset();
await page.keyboard.press('a');
out.scenarios.push(await collect('1 keystroke in composer'));
await box.fill('');

await reset();
await author.put(`/api/messages/${msgs[msgs.length - 1].id}/reactions/${encodeURIComponent('👍')}`);
out.scenarios.push(await collect('1 reaction by another user'));

// typing indicator travels over the socket only: use a second browser page for the author
const ctx2 = await browser.newContext();
await ctx2.addCookies([cookieFor(author)]);
await ctx2.route((u) => !u.href.startsWith(BASE) && /^https?:/.test(u.href), (r) => r.abort());
const p2 = await ctx2.newPage();
await p2.goto(`${BASE}/channels/${world.serverId}/${world.long.id}`);
const box2 = p2.locator('textarea[aria-label^="Message"]').first();
await box2.waitFor({ timeout: 20_000 });
await sleep(1500);
await reset();
await box2.pressSequentially('hi', { delay: 50 });
await page.getByText(/is typing/).first().waitFor({ timeout: 8000 }).catch(() => {});
out.scenarios.push(await collect('typing indicator from another user'));

console.log('wrote', writeJson('renders.json', out));
await browser.close();
srv.stop();
process.exit(0);
