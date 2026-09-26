#!/usr/bin/env node
// ============================================================================
//  UX persona study — accessibility group (Aisha / Tom / Kenji).
//
//  Drives an already-running server (UX_BASE, default http://localhost:7030)
//  with keyboard-only navigation, axe-core scans on every screen, live-region
//  monitoring, target-size measurement, deuteranopia simulation, text-spacing
//  and 400% reflow checks. Prints a JSON summary and writes screenshots to
//  UX_SHOTS/persona-accessibility-*.png.
//
//  Setup: npm i --no-save playwright-core @axe-core/playwright
//  Usage: UX_BASE=http://localhost:7030 node scripts/ux/accessibility.mjs [phase…]
//         phases: setup aisha tom kenji (default: all)
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import { AxeBuilder } from '@axe-core/playwright';

const BASE = process.env.UX_BASE || 'http://localhost:7030';
const SHOTS = process.env.UX_SHOTS
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';
const OUT = process.env.UX_OUT || path.join(SHOTS, 'persona-accessibility-results.json');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const RUN = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'correct-horse-battery-9';
fs.mkdirSync(SHOTS, { recursive: true });

const R = { run: RUN, axe: {}, tasks: [], notes: [], focus: {}, live: {}, targets: {}, color: {}, reflow: {} };
const note = (who, text) => { R.notes.push({ who, text }); console.log(`  [${who}] ${text}`); };
const shot = async (page, name) => {
  const f = path.join(SHOTS, `persona-accessibility-${name}.png`);
  await page.screenshot({ path: f }).catch(() => {});
  return f;
};

// --- axe ---------------------------------------------------------------------
async function axe(page, screen) {
  try {
    const res = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    const v = res.violations.map((x) => ({
      id: x.id, impact: x.impact, nodes: x.nodes.length,
      sample: x.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} :: ${(n.failureSummary || '').split('\n')[1]?.trim() ?? ''}`.slice(0, 220))
    }));
    R.axe[screen] = { count: v.length, nodes: v.reduce((s, x) => s + x.nodes, 0), violations: v };
    console.log(`  axe ${screen}: ${v.length} rules / ${R.axe[screen].nodes} nodes — ${v.map((x) => `${x.id}(${x.nodes})`).join(', ')}`);
  } catch (e) {
    R.axe[screen] = { error: String(e.message).slice(0, 200) };
    console.log(`  axe ${screen}: ERROR ${e.message}`);
  }
}

// --- task timer ---------------------------------------------------------------
async function task(who, name, fn) {
  const t0 = Date.now();
  const ctx = { keys: 0, clicks: 0, issues: [] };
  let ok = true; let err = null;
  try { await fn(ctx); } catch (e) {
    ok = false; err = String(e.message).split('\n')[0].slice(0, 240);
    const pg = globalThis.__curPage;
    if (pg && !pg.isClosed()) await pg.screenshot({ path: path.join(SHOTS, `persona-accessibility-FAIL-${who}-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`) }).catch(() => {});
  }
  const rec = { who, name, ok, secs: +((Date.now() - t0) / 1000).toFixed(1), keys: ctx.keys, clicks: ctx.clicks, issues: ctx.issues, err };
  R.tasks.push(rec);
  console.log(`${ok ? 'PASS' : 'FAIL'} [${who}] ${name} (${rec.secs}s, keys ${ctx.keys}, clicks ${ctx.clicks})${err ? ' — ' + err : ''}`);
  return ok;
}

// Keyboard helper that counts presses and records what got focus.
function kb(page, ctx) {
  return {
    async press(key, n = 1) { for (let i = 0; i < n; i += 1) { await page.keyboard.press(key); ctx.keys += 1; } await page.waitForTimeout(60); },
    async type(text) { await page.keyboard.type(text, { delay: 10 }); ctx.keys += text.length; },
    async focused() { return page.evaluate(describeActive); },
    /** Tab until predicate(desc) is true; returns the path walked. */
    async tabTo(pred, max = 80, key = 'Tab') {
      const walk = [];
      for (let i = 0; i < max; i += 1) {
        await page.keyboard.press(key); ctx.keys += 1;
        const d = await page.evaluate(describeActive);
        walk.push(d);
        if (pred(d)) return walk;
      }
      throw new Error(`tabTo: not reached after ${max} presses; last=${walk.slice(-4).map((d) => d.label).join(' | ')}`);
    }
  };
}

function describeActive() {
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: 'body', label: '(body)', role: '', visibleFocus: false };
  const name = el.getAttribute('aria-label') || el.getAttribute('title') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.innerText || el.value || '';
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const visibleFocus = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
  return {
    tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', id: el.id || '',
    label: String(name).trim().replace(/\s+/g, ' ').slice(0, 60),
    visibleFocus, w: Math.round(r.width), h: Math.round(r.height), inView: r.bottom > 0 && r.top < innerHeight && r.width > 0
  };
}

// --- live region monitor --------------------------------------------------------
// Records every text mutation inside aria-live / role=status|alert|log regions,
// which approximates what NVDA/VoiceOver would speak.
async function installLiveMonitor(page) {
  await page.evaluate(() => {
    if (window.__live) return;
    window.__live = [];
    const liveSel = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"]';
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        const node = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        const region = node?.closest?.(liveSel);
        if (!region) continue;
        const txt = (m.type === 'characterData' ? m.target.textContent : [...m.addedNodes].map((n) => n.textContent).join(' ')).trim();
        if (txt) window.__live.push({ t: Date.now(), role: region.getAttribute('role') || region.getAttribute('aria-live'), text: txt.slice(0, 120) });
      }
    });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
const liveSince = (page, t) => page.evaluate((t0) => (window.__live || []).filter((x) => x.t >= t0), t);

// --- accessibility tree helpers ------------------------------------------------------
async function landmarksAndHeadings(page) {
  return page.evaluate(() => {
    const lm = [...document.querySelectorAll('main,nav,aside,header,footer,[role=main],[role=navigation],[role=complementary],[role=banner],[role=contentinfo],[role=region][aria-label],section[aria-label],form[aria-label],[role=search]')]
      .filter((e) => e.getClientRects().length)
      .map((e) => `${e.getAttribute('role') || e.tagName.toLowerCase()}${e.getAttribute('aria-label') ? `"${e.getAttribute('aria-label')}"` : ''}`);
    const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')]
      .filter((e) => e.getClientRects().length)
      .map((e) => `${e.tagName}${e.getAttribute('aria-level') || ''}:${e.innerText.trim().slice(0, 40)}`);
    return { landmarks: lm, headings: hs, lang: document.documentElement.lang, title: document.title };
  });
}

// Interactive targets smaller than 24x24 (WCAG 2.5.8) and 44x44 (2.5.5 AAA / Apple HIG).
async function targetSizes(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a[href], [role=button], [role=menuitem], [role=tab], [role=switch], [role=checkbox], [role=radio], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
    const vis = els.filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0' && r.bottom > 0 && r.top < innerHeight; });
    const small = []; let under44 = 0;
    for (const e of vis) {
      const r = e.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) under44 += 1;
      if (r.width < 24 || r.height < 24) {
        small.push(`${(e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || e.tagName).trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return { total: vis.length, under24: small.length, under44, sample: small.slice(0, 25) };
  });
}

// Deuteranopia simulation via SVG feColorMatrix (Machado et al. 2009, severity 1.0).
const DEUTAN = '0.367 0.861 -0.228 0 0  0.280 0.673 0.047 0 0  -0.012 0.043 0.969 0 0  0 0 0 1 0';
async function deutanShot(page, name) {
  await page.evaluate((m) => {
    if (!document.getElementById('__deutan')) {
      const d = document.createElement('div');
      d.innerHTML = `<svg id="__deutan" style="position:absolute;width:0;height:0"><filter id="deutan"><feColorMatrix type="matrix" values="${m}"/></filter></svg>`;
      document.body.appendChild(d.firstChild);
    }
    document.documentElement.style.filter = 'url(#deutan)';
  }, DEUTAN);
  const f = await shot(page, name);
  await page.evaluate(() => { document.documentElement.style.filter = ''; });
  return f;
}

// WCAG 1.4.12 text spacing bookmarklet.
const TEXT_SPACING_CSS = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';
async function clippedText(page) {
  return page.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('button, a, label, span, p, h1, h2, h3, div')) {
      if (e.children.length > 2) continue;
      const cs = getComputedStyle(e);
      if (!e.innerText?.trim() || e.getClientRects().length === 0) continue;
      const clips = (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden' || cs.textOverflow === 'ellipsis');
      if (clips && (e.scrollWidth > e.clientWidth + 2 || e.scrollHeight > e.clientHeight + 2)) out.push(e.innerText.trim().slice(0, 40));
    }
    return { count: out.length, sample: [...new Set(out)].slice(0, 20) };
  });
}
const hScroll = (page) => page.evaluate(() => ({ docW: document.documentElement.scrollWidth, vw: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 }));

// --- shared app helpers --------------------------------------------------------------
async function newCtx(browser, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, permissions: ['clipboard-read', 'clipboard-write', 'microphone', 'camera'], ...opts });
  await context.route((u) => !u.href.startsWith(BASE) && /^https?:/.test(u.href), (r) => r.abort());
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  page.errors = errors;
  return { context, page };
}
async function registerMouse(page, username) {
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel(/Username/).fill(username);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await page.getByRole('navigation', { name: 'Servers' }).waitFor();
}
const composer = (page) => page.locator('textarea[aria-label^="Message"], [role="textbox"][aria-label^="Message"], #message-composer').first();
const msgRow = (page, text) => page.locator('[id^="message-"]:not(#message-composer)').filter({ hasText: text });
async function say(page, text) {
  const box = composer(page); await box.click(); await box.fill(text); await box.press('Enter');
  await msgRow(page, text).first().waitFor();
}

// ============================================================================
const phases = new Set(process.argv.slice(2));
const want = (p) => phases.size === 0 || phases.has(p);

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
});

// --- friend (Mina) sets up the server the personas will join ------------------------------
const mina = `mina_${RUN}`;
const M = await newCtx(browser);
const m = M.page;
const serverName = `Book Club ${RUN}`;
let inviteUrl;
await registerMouse(m, mina);
await m.getByRole('button', { name: 'Add a server' }).click();
await m.getByRole('button', { name: /Create my own/ }).click();
await m.getByPlaceholder('e.g. Chill Squad HQ').fill(serverName);
await m.getByRole('button', { name: /^Create$/ }).click();
await m.getByText(serverName).first().waitFor();
const offer = m.getByRole('dialog', { name: /Invite friends/ });
if (await offer.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
  await m.waitForFunction(() => /\/invite\//.test(document.getElementById('invite-link')?.value ?? ''), null, { timeout: 8000 });
  inviteUrl = await offer.getByLabel('Invite link').inputValue();
  await m.keyboard.press('Escape');
}
if (!inviteUrl) {
  await m.getByText(serverName).first().click();
  await m.getByRole('menuitem', { name: 'Invite people' }).or(m.getByRole('button', { name: 'Invite people' })).first().click();
  await m.waitForFunction(() => /\/invite\//.test(document.getElementById('invite-link')?.value ?? ''), null, { timeout: 8000 });
  inviteUrl = await m.getByLabel('Invite link').inputValue();
  await m.keyboard.press('Escape');
}
for (let i = 1; i <= 6; i += 1) await say(m, `Chapter ${i} thoughts: the narrator is unreliable, discuss (${i})`);
console.log('invite', inviteUrl);
R.inviteUrl = inviteUrl;

// Screens axe-scanned from Mina's (sighted owner's) view.
await axe(m, 'owner-channel');

// PERSONAS
if (want('aisha')) await aisha().catch((e) => console.log('aisha crashed', e.stack));
if (want('tom')) await tom().catch((e) => console.log('tom crashed', e.stack));
if (want('kenji')) await kenji().catch((e) => console.log('kenji crashed', e.stack));

fs.writeFileSync(OUT, JSON.stringify(R, null, 2));
console.log('results →', OUT);
await browser.close();

function fmt(d) { return `${d.tag}${d.role ? '[' + d.role + ']' : ''}:${d.label}${d.visibleFocus ? '' : ' (no ring)'}`; }

// ============================================================================
//  Aisha — blind, NVDA/VoiceOver, keyboard only. 1366x768 laptop.
// ============================================================================
async function aisha() {
  const who = 'aisha';
  const user = `aisha_${RUN}`;
  const A = await newCtx(browser);
  const a = A.page;
  globalThis.__curPage = a;

  await task(who, 'cold start: understand the login page (tree/landmarks)', async (c) => {
    await a.goto(BASE + '/');
    await a.waitForLoadState('networkidle');
    await axe(a, 'login');
    R.focus.loginTree = await landmarksAndHeadings(a);
    await shot(a, 'aisha-01-login');
    const k = kb(a, c);
    const walk = [];
    for (let i = 0; i < 14; i += 1) { await k.press('Tab'); walk.push(await k.focused()); }
    R.focus.loginTabOrder = walk.map(fmt);
  });

  await task(who, 'register with keyboard only', async (c) => {
    const k = kb(a, c);
    await a.goto(BASE + '/');
    await k.tabTo((d) => /sign up|register|create an account/i.test(d.label));
    await k.press('Enter');
    await a.waitForTimeout(200);
    const f0 = await k.focused();
    c.issues.push(`focus after switching to sign-up: ${fmt(f0)}`);
    if (!(f0.tag === 'input')) await k.tabTo((d) => d.tag === 'input' && /user/i.test(d.label + d.id), 20);
    await k.type(user);
    await k.tabTo((d) => d.tag === 'input' && /^password/i.test(d.label), 8);
    await k.type(PASSWORD);
    await installLiveMonitor(a);
    const t0 = Date.now();
    await k.press('Enter');
    await a.getByRole('navigation', { name: 'Servers' }).waitFor({ timeout: 10000 });
    await a.waitForTimeout(800);
    const f = await k.focused();
    c.issues.push(`focus after register lands on: ${fmt(f)}; title=${await a.title()}`);
    R.live.afterRegister = await liveSince(a, t0);
    await shot(a, 'aisha-02-after-register');
    await axe(a, 'home-empty');
    R.focus.homeTree = await landmarksAndHeadings(a);
  });

  await task(who, 'join friend server via invite link (keyboard)', async (c) => {
    const k = kb(a, c);
    await a.goto(inviteUrl);
    await a.waitForLoadState('networkidle');
    await axe(a, 'invite-screen');
    R.focus.inviteTree = await landmarksAndHeadings(a);
    await shot(a, 'aisha-03-invite');
    await k.tabTo((d) => /accept/i.test(d.label), 30);
    await k.press('Enter');
    await a.getByText(serverName).first().waitFor();
    await a.waitForTimeout(1200);
    const f = await k.focused();
    c.issues.push(`focus after join: ${fmt(f)}; title=${await a.title()}`);
    const dlg = await a.locator('[role=dialog]').count();
    if (dlg) { c.issues.push('a dialog opened after join'); await shot(a, 'aisha-03b-after-join-dialog'); await k.press('Escape'); }
    await axe(a, 'channel-member');
    R.focus.channelTree = await landmarksAndHeadings(a);
    R.focus.channelSnapshot = (await a.locator('body').ariaSnapshot().catch((e) => String(e))).slice(0, 12000);
    await shot(a, 'aisha-04-channel');
  });

  await task(who, 'skip links + tab count to reach the composer', async (c) => {
    const k = kb(a, c);
    await a.reload(); await a.waitForLoadState('networkidle'); await a.waitForTimeout(800);
    const first = await k.tabTo(() => true, 1);
    c.issues.push(`first tab stop: ${fmt(first[0])} inView=${first[0].inView}`);
    await a.reload(); await a.waitForLoadState('networkidle'); await a.waitForTimeout(800);
    let walk;
    try { walk = await k.tabTo((d) => /^message/i.test(d.label) && ['textarea', 'div'].includes(d.tag), 150); } catch (e) { walk = null; c.issues.push(e.message); }
    R.focus.tabsToComposerNoSkip = walk ? walk.length : '>150';
    R.focus.channelTabOrder = (walk || []).slice(0, 80).map(fmt);
  });

  await task(who, 'read the channel (message semantics / arrow navigation)', async (c) => {
    const info = await a.evaluate(() => {
      const rows = [...document.querySelectorAll('[id^="message-"]:not(#message-composer)')];
      const r0 = rows[rows.length - 1];
      const anc = [];
      for (let e = r0?.parentElement; e && e !== document.body; e = e.parentElement) {
        if (e.getAttribute('role') || e.getAttribute('aria-label') || /^(OL|UL|MAIN|SECTION)$/.test(e.tagName)) anc.push(`${e.tagName}[role=${e.getAttribute('role')}][label=${e.getAttribute('aria-label')}][live=${e.getAttribute('aria-live')}]`);
      }
      return {
        count: rows.length, ancestors: anc,
        rowRole: r0?.getAttribute('role'), rowTag: r0?.tagName, rowTabindex: r0?.getAttribute('tabindex'),
        rowLabel: r0?.getAttribute('aria-label') || r0?.getAttribute('aria-labelledby'),
        rowText: r0?.innerText.replace(/\s+/g, ' ').slice(0, 200),
        hasTimeEl: !!r0?.querySelector('time'), timeLabel: r0?.querySelector('time')?.getAttribute('aria-label') || r0?.querySelector('time')?.getAttribute('datetime'),
        authorHeading: !!r0?.querySelector('h1,h2,h3,h4,[role=heading]')
      };
    });
    R.focus.messageStructure = info;
    const k = kb(a, c);
    await composer(a).focus();
    await k.press('Shift+Tab'); const b1 = await k.focused();
    await k.press('Shift+Tab'); const b2 = await k.focused();
    await k.press('Shift+Tab'); const b3 = await k.focused();
    R.focus.shiftTabFromComposer = [b1, b2, b3].map((d) => `${fmt(d)} id=${d.id}`);
    await composer(a).focus();
    await k.press('Alt+ArrowUp'); const au = await k.focused();
    await composer(a).focus();
    await k.press('ArrowUp'); const up = await k.focused();
    R.focus.arrowFromComposer = { altUp: `${fmt(au)} id=${au.id}`, up: `${fmt(up)} id=${up.id}` };
    await k.press('Escape');
  });

  await task(who, 'hear new message + typing announcement from friend', async (c) => {
    await installLiveMonitor(a);
    const t0 = Date.now();
    const box = composer(m);
    await box.click();
    await box.pressSequentially('Aisha, did you finish ch', { delay: 60 });
    await a.waitForTimeout(1500);
    const typingVisible = await a.getByText(/is typing/).count();
    await box.fill('');
    await say(m, `Welcome Aisha! Did you finish chapter 6? ${RUN}`);
    await msgRow(a, 'Welcome Aisha!').first().waitFor();
    await a.waitForTimeout(800);
    const heard = await liveSince(a, t0);
    R.live.newMessage = heard;
    c.issues.push(`typing indicator visible=${typingVisible}; live announcements: ${heard.length ? heard.map((h) => h.text).join(' / ') : 'NONE'}`);
    if (!heard.some((h) => /Welcome Aisha/.test(h.text))) throw new Error('incoming message was not announced via any live region');
  });

  await task(who, 'reply to friend with keyboard', async (c) => {
    const k = kb(a, c);
    await composer(a).focus();
    let reached = null; const path0 = [];
    for (let i = 0; i < 40; i += 1) {
      await k.press('Shift+Tab');
      const d = await k.focused();
      path0.push(fmt(d));
      if (/^reply/i.test(d.label)) { reached = d; break; }
    }
    R.focus.replyHunt = path0;
    c.issues.push(`reply control reached=${reached ? reached.label : 'no'} via Shift+Tab (${path0.length} presses)`);
    await shot(a, 'aisha-05-reply-hunt');
    if (!reached) {
      const row = msgRow(a, 'Welcome Aisha').first();
      const focusable = await row.evaluate((r) => r.tabIndex >= 0);
      c.issues.push(`message row focusable=${focusable}`);
      const inTree = await row.getByRole('button', { name: /^reply/i }).count();
      c.issues.push(`Reply button present in accessibility tree (NVDA browse mode)=${inTree > 0}`);
      R.focus.messageRowAria = (await row.ariaSnapshot().catch((e) => String(e))).slice(0, 1500);
      throw new Error('no keyboard path to Reply');
    }
    await k.press('Enter');
    await a.waitForTimeout(300);
    const f = await k.focused();
    c.issues.push(`focus after Reply: ${fmt(f)}`);
    const replying = await a.getByText(/Replying to/i).count();
    if (!replying) throw new Error('Replying banner not shown');
    await k.type('Yes! The twist in chapter 6 got me.');
    await k.press('Enter');
    await msgRow(m, 'The twist in chapter 6').first().waitFor();
  });

  await task(who, 'add a reaction with keyboard', async (c) => {
    const k = kb(a, c);
    await composer(a).focus();
    let reached = null;
    for (let i = 0; i < 40; i += 1) {
      await k.press('Shift+Tab');
      const d = await k.focused();
      if (/add reaction|^react/i.test(d.label)) { reached = d; break; }
    }
    if (!reached) throw new Error('no reachable "Add reaction" control by Shift+Tab');
    const inWhich = await a.evaluate(() => document.activeElement.closest('[id^="message-"]')?.innerText.slice(0, 50));
    c.issues.push(`reached: ${fmt(reached)} size=${reached.w}x${reached.h} inView=${reached.inView} on message "${inWhich}"`);
    await shot(a, 'aisha-06a-reaction-focus');
    await k.press('Enter');
    await a.waitForTimeout(500);
    await shot(a, 'aisha-06-emoji-picker');
    await axe(a, 'emoji-picker');
    const f = await k.focused();
    c.issues.push(`focus in picker: ${fmt(f)}`);
    R.focus.emojiPicker = await a.evaluate(() => {
      const d = document.activeElement.closest('[role=dialog],[role=menu],[class*="picker" i]') || document.querySelector('[role=dialog]');
      if (!d) return null;
      const btns = [...d.querySelectorAll('button')];
      return { role: d.getAttribute('role'), label: d.getAttribute('aria-label'), grid: !!d.querySelector('[role=grid],[role=listbox]'), btns: btns.length, named: btns.filter((b) => b.getAttribute('aria-label') || b.title).length, sampleNames: btns.slice(10, 16).map((b) => b.getAttribute('aria-label') || b.title || b.innerText) };
    });
    await k.type('thumbs');
    await a.waitForTimeout(300);
    await k.press('Enter');
    await a.waitForTimeout(400);
    let f2 = await k.focused();
    c.issues.push(`after typing "thumbs"+Enter: ${fmt(f2)}`);
    if (await a.locator('[id^="message-"] button[aria-pressed="true"]').count() === 0) {
      await k.press('Tab'); await k.press('Enter'); await a.waitForTimeout(400);
      f2 = await k.focused();
      c.issues.push(`after Tab+Enter: ${fmt(f2)}`);
    }
    await a.waitForTimeout(600);
    const rb = await a.locator('[id^="message-"] button').filter({ hasText: /^\S+\s*1$/ }).first()
      .evaluate((b) => ({ label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), text: b.innerText, title: b.title })).catch(() => null);
    R.focus.reactionButton = rb;
    if (!rb) throw new Error('reaction did not land');
  });

  await task(who, 'keyboard shortcuts help (Ctrl+/)', async (c) => {
    const k = kb(a, c);
    await composer(a).focus();
    await k.press('Control+/');
    await a.waitForTimeout(500);
    const dlg = a.getByRole('dialog');
    const open = await dlg.count();
    c.issues.push(`Ctrl+/ shortcuts dialog open=${open}`);
    if (!open) throw new Error('no shortcut help');
    await axe(a, 'shortcuts-modal');
    await shot(a, 'aisha-07-shortcuts');
    R.focus.shortcutsText = (await dlg.first().innerText()).slice(0, 2000);
    await k.press('Escape');
    const f = await k.focused();
    c.issues.push(`focus returns after Esc: ${fmt(f)}`);
  });

  await task(who, 'join voice channel with keyboard', async (c) => {
    const k = kb(a, c);
    await installLiveMonitor(a);
    await a.evaluate(() => document.querySelector('a.skip-link[href="#channel-list"]')?.focus());
    const sk = await k.focused();
    c.issues.push(`skip link: ${fmt(sk)} inView=${sk.inView}`);
    await k.press('Enter');
    const after = await k.focused();
    c.issues.push(`after skip-to-channels: ${fmt(after)}`);
    const walk = await k.tabTo((d) => /^general voice/i.test(d.label), 40);
    R.focus.channelListWalk = [after, ...walk].map(fmt);
    const f = walk[walk.length - 1];
    c.issues.push(`voice channel focus: ${fmt(f)}`);
    const t0 = Date.now();
    await k.press('Enter');
    await a.waitForTimeout(3000);
    await shot(a, 'aisha-08-voice');
    await axe(a, 'voice-connected');
    const heard = await liveSince(a, t0);
    R.live.voice = heard;
    c.issues.push(`voice announcements: ${heard.map((h) => h.text).join(' / ') || 'NONE'}; focus now ${fmt(await k.focused())}`);
    R.focus.voiceControls = await a.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /mute|deafen|disconnect|leave|camera|screen/i.test(b.getAttribute('aria-label') || b.title || '')).map((b) => `${b.getAttribute('aria-label') || b.title} pressed=${b.getAttribute('aria-pressed')} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`));
    const dc = a.getByRole('button', { name: /disconnect|leave call|hang up/i }).first();
    if (!(await dc.count())) throw new Error('no named disconnect button');
    await dc.focus(); await k.press('Enter');
  });

  await task(who, 'open settings, toggle reduced motion, close — keyboard', async (c) => {
    const k = kb(a, c);
    await composer(a).focus();
    const walk = await k.tabTo((d) => /user settings|^settings/i.test(d.label) && d.tag === 'button', 80);
    c.issues.push(`tabs from composer to settings: ${walk.length}`);
    await k.press('Enter');
    await a.waitForTimeout(700);
    await shot(a, 'aisha-09-settings');
    await axe(a, 'user-settings');
    const f = await k.focused();
    c.issues.push(`focus when settings opens: ${fmt(f)}`);
    R.focus.settingsTree = await landmarksAndHeadings(a);
    R.focus.settingsDialog = await a.evaluate(() => {
      const d = document.querySelector('[role=dialog]');
      return d ? { label: d.getAttribute('aria-label') || d.getAttribute('aria-labelledby'), modal: d.getAttribute('aria-modal'), tabs: d.querySelectorAll('[role=tab]').length, current: d.querySelector('[aria-current],[aria-selected=true]')?.innerText } : null;
    });
    const wk = await k.tabTo((d) => /accessibility/i.test(d.label), 60);
    c.issues.push(`tabs to Accessibility nav item: ${wk.length}`);
    await k.press('Enter');
    await a.waitForTimeout(400);
    await axe(a, 'settings-accessibility');
    await shot(a, 'aisha-10-a11y-tab');
    const sw = await k.tabTo((d) => /reduce|motion/i.test(d.label), 30);
    const last = sw[sw.length - 1];
    const before = await a.evaluate(() => document.activeElement.getAttribute('aria-checked') ?? String(document.activeElement.checked));
    await k.press('Space');
    await a.waitForTimeout(300);
    const after = await a.evaluate(() => document.activeElement.getAttribute('aria-checked') ?? String(document.activeElement.checked));
    c.issues.push(`switch "${last.label}" role=${last.role} tag=${last.tag} ${before}→${after}`);
    let escaped = false;
    for (let i = 0; i < 100; i += 1) { await k.press('Tab'); if (!(await a.evaluate(() => !!document.activeElement.closest('[role=dialog]')))) { escaped = true; break; } }
    c.issues.push(`focus trapped in settings=${!escaped}`);
    await k.press('Escape');
    await a.waitForTimeout(400);
    const back = await k.focused();
    c.issues.push(`focus after closing settings: ${fmt(back)}`);
    if (String(before) === String(after)) throw new Error('switch did not toggle with Space');
  });

  R.pageErrors = { ...(R.pageErrors || {}), aisha: A.page.errors };
}

// Gaussian jitter hit test: would a tremor click (σ px) land on this element?
async function tremorHitRate(page, locator, sigma = 6, n = 40) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return null;
  return page.evaluate(({ box, sigma, n, sel }) => {
    const target = document.querySelector(`[data-ux-probe="${sel}"]`);
    let hits = 0;
    const g = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    for (let i = 0; i < n; i += 1) {
      const x = box.x + box.width / 2 + g() * sigma; const y = box.y + box.height / 2 + g() * sigma;
      const el = document.elementFromPoint(x, y);
      if (el && (el === target || target.contains(el))) hits += 1;
    }
    return { w: Math.round(box.width), h: Math.round(box.height), hitRate: +(hits / n).toFixed(2) };
  }, { box, sigma, n, sel: await locator.evaluate((e) => { const id = Math.random().toString(36).slice(2); e.setAttribute('data-ux-probe', id); return id; }) });
}

// ============================================================================
//  Tom — tremor; keyboard + 2-switch access (Tab = next, Enter = select).
//  Laptop 1366x768; later retries at app zoom 150%.
// ============================================================================
async function tom() {
  const who = 'tom';
  const user = `tom_${RUN}`;
  const T = await newCtx(browser);
  const t = T.page;
  globalThis.__curPage = t;
  await registerMouse(t, user);
  await t.goto(inviteUrl);
  await t.getByRole('button', { name: /Accept invite/ }).click();
  await t.getByText(serverName).first().waitFor();
  await t.waitForTimeout(1000);
  if (await t.locator('[role=dialog]').count()) await t.keyboard.press('Escape');
  await t.getByRole('button', { name: /^general$/ }).first().click().catch(() => {});
  await t.waitForTimeout(500);

  await task(who, 'target-size audit (channel view)', async (c) => {
    R.targets.channel = await targetSizes(t);
    c.issues.push(`${R.targets.channel.under24}/${R.targets.channel.total} targets <24px; ${R.targets.channel.under44} <44px`);
    await shot(t, 'tom-01-channel');
  });

  await task(who, 'tremor hit-rate on common controls (σ=6px)', async (c) => {
    const probes = {
      'Notification settings': t.getByRole('button', { name: 'Notification settings' }).first(),
      'Pinned messages': t.getByRole('button', { name: 'Pinned messages' }).first(),
      'Member list': t.getByRole('button', { name: 'Member list' }).first(),
      'Inbox': t.getByRole('button', { name: 'Inbox' }).first(),
      'Mute (user panel)': t.getByRole('button', { name: 'Mute' }).first(),
      'User settings': t.getByRole('button', { name: 'User settings' }).first(),
      'Emoji (composer)': t.getByRole('button', { name: 'Emoji' }).first(),
      'Upload (composer)': t.getByRole('button', { name: 'Upload files or images' }).first(),
      'Channel "general"': t.getByRole('button', { name: /^general$/ }).first()
    };
    const out = {};
    for (const [k, loc] of Object.entries(probes)) out[k] = await tremorHitRate(t, loc);
    // Hover toolbar buttons on a message.
    const row = msgRow(t, 'Chapter 6').first();
    await row.hover();
    await t.waitForTimeout(200);
    for (const name of [/^React with/, /^Add reaction/, /^Reply/, /^More/]) {
      const b = row.getByRole('button', { name }).first();
      out[`message toolbar ${name.source}`] = await tremorHitRate(t, b);
    }
    await shot(t, 'tom-02-hover-toolbar');
    R.targets.tremor = out;
    c.issues.push(Object.entries(out).map(([k, v]) => `${k}: ${v ? `${v.w}x${v.h} ${Math.round(v.hitRate * 100)}%` : 'n/a'}`).join('; '));
  });

  await task(who, 'hover toolbar survives shaky mouse path', async (c) => {
    // Move from message text towards the toolbar with a wobble; does the toolbar disappear en route?
    const row = msgRow(t, 'Chapter 5').first();
    const rb = await row.boundingBox();
    await t.mouse.move(rb.x + 200, rb.y + rb.height / 2);
    await t.waitForTimeout(150);
    const tb = row.locator('.message-actions');
    const tbb = await tb.boundingBox();
    let lost = 0; const steps = 12;
    for (let i = 1; i <= steps; i += 1) {
      const x = rb.x + 200 + ((tbb.x + 20 - rb.x - 200) * i) / steps + (Math.random() - 0.5) * 14;
      const y = rb.y + rb.height / 2 + ((tbb.y + tbb.height / 2 - rb.y - rb.height / 2) * i) / steps + (Math.random() - 0.5) * 14;
      await t.mouse.move(x, y);
      if (!(await tb.isVisible())) lost += 1;
    }
    c.issues.push(`toolbar ${tbb.width | 0}x${tbb.height | 0} vanished on ${lost}/${steps} wobble steps`);
  });

  await task(who, 'accidental double-click adds a ❤️ reaction (tap-to-react default)', async (c) => {
    const row = msgRow(t, 'Chapter 3').first();
    const pill = row.locator('button[aria-pressed]').filter({ hasText: /❤/ });
    const before = await pill.count();
    await row.getByText(/Chapter 3/).first().dblclick();
    await t.waitForTimeout(900);
    const afterOnText = await pill.count();
    const rb = await row.boundingBox();
    await t.mouse.dblclick(rb.x + rb.width - 260, rb.y + rb.height / 2);
    await t.waitForTimeout(900);
    const after = await pill.count();
    c.issues.push(`double-click on the words: +${afterOnText - before} (selects a word instead); on blank part of row: +${after - afterOnText}`);
    c.issues.push(`hearts before=${before} after=${after}`);
    await shot(t, 'tom-03-accidental-heart');
    if (after > before) throw new Error('a double-click (common with tremor) silently reacted ❤️ for everyone to see');
  });

  await task(who, 'react via right-click menu + arrow keys (no hover)', async (c) => {
    const k = kb(t, c);
    const row = msgRow(t, 'Chapter 4').first();
    await row.click({ button: 'right' }); c.clicks += 1;
    await t.waitForTimeout(300);
    const menu = t.getByRole('menu').first();
    await menu.waitFor();
    const f = await k.focused();
    c.issues.push(`focus in menu: ${fmt(f)} size=${f.w}x${f.h}`);
    R.targets.contextMenu = await targetSizes(t);
    await shot(t, 'tom-04-context-menu');
    await axe(t, 'message-context-menu');
    const items = await menu.getByRole('menuitem').evaluateAll((els) => els.map((e) => `${e.innerText.trim().split('\n')[0]} ${Math.round(e.getBoundingClientRect().height)}px`));
    c.issues.push(`menu items: ${items.length} (${items.slice(0, 6).join(', ')}…)`);
    await k.tabTo((d) => /reaction/i.test(d.label), 25, 'ArrowDown');
    await k.press('Enter');
    await t.waitForTimeout(400);
    await shot(t, 'tom-05-picker-from-menu');
    await axe(t, 'emoji-picker');
    R.targets.emojiPicker = await t.evaluate(() => {
      const inp = document.activeElement;
      const d = inp.closest('[role=dialog]') || inp.parentElement?.parentElement?.parentElement;
      const r = d?.getBoundingClientRect();
      return { focus: inp.getAttribute('aria-label') || inp.placeholder, role: d?.getAttribute('role'), label: d?.getAttribute('aria-label'), offscreen: r ? r.right > innerWidth || r.bottom > innerHeight : null, rect: r && [Math.round(r.x), Math.round(r.y), Math.round(r.right), Math.round(r.bottom)] };
    });
    await k.type('heart');
    await k.press('Enter');
    await t.waitForTimeout(600);
    const ok = await row.locator('button').filter({ hasText: /❤|💖|💕|♥/ }).count();
    if (!ok) throw new Error('reaction via menu+keyboard failed');
  });

  await task(who, 'switch access: Tab-count to reach Reply for the latest message', async (c) => {
    // A switch user steps with Tab. Count stops from the top of the page to *any* message action.
    const k = kb(t, c);
    await t.mouse.move(5, 760);
    await t.reload(); await t.waitForLoadState('networkidle'); await t.waitForTimeout(600);
    let found = null;
    try { const w = await k.tabTo((d) => /^reply/i.test(d.label), 120); found = w.length; R.focus.tomReplyPath = w.map(fmt); } catch { /* none */ }
    const where = await t.evaluate(() => { const e = document.activeElement; return `${e.closest('[id^="message-"]')?.id ?? 'not in a message'} toolbar=${!!e.closest('.message-actions')} visible=${e.getBoundingClientRect().width > 0}`; });
    c.issues.push(`Tab stops to a Reply button: ${found ?? 'unreachable in 120'} (${where})`);
    await shot(t, 'tom-04b-reply-by-tab');
    if (!found) throw new Error('Reply unreachable by switch/Tab');
  });

  await task(who, 'toast timing — auto-dismiss without pause on hover/focus', async (c) => {
    // Copying a message link shows a toast; measure how long it stays and whether hovering pauses it.
    const row = msgRow(t, 'Chapter 2').first();
    await row.click({ button: 'right' });
    const copy = t.getByRole('menuitem', { name: /copy (message )?link|copy text/i }).first();
    if (!(await copy.count())) { c.issues.push('no copy item'); await t.keyboard.press('Escape'); return; }
    await copy.click();
    const toast = t.locator('[role=status]').filter({ hasText: /cop/i }).first();
    const shown = await toast.waitFor({ timeout: 2000 }).then(() => true, () => false);
    if (!shown) { c.issues.push('no toast after copy'); return; }
    const tb = await toast.boundingBox();
    await t.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    const t0 = Date.now();
    await toast.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
    c.issues.push(`toast disappeared ${((Date.now() - t0) / 1000).toFixed(1)}s after hover (pause-on-hover=${Date.now() - t0 > 12000})`);
  });

  await task(who, 'join voice + push-to-talk (hold) + disconnect', async (c) => {
    await t.getByRole('button', { name: /^General Voice/ }).first().click(); c.clicks += 1;
    await t.waitForTimeout(2000);
    R.targets.voice = await targetSizes(t);
    await shot(t, 'tom-06-voice');
    const ptt = t.getByRole('button', { name: /push to talk/i }).first();
    c.issues.push(`PTT toggle present=${await ptt.count() > 0}; voice view targets <24: ${R.targets.voice.under24}`);
    const dc = t.getByRole('button', { name: /^Disconnect/ });
    const sizes = await dc.evaluateAll((els) => els.map((e) => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
    c.issues.push(`Disconnect buttons: ${sizes.join(', ')}`);
    // Does disconnect ask for confirmation? (accidental hang-up risk)
    await dc.last().click(); c.clicks += 1;
    await t.waitForTimeout(500);
    c.issues.push(`confirm dialog on disconnect=${await t.getByRole('dialog').count() > 0}`);
  });

  await task(who, 'raise app zoom to 200% via keyboard (Settings › Appearance)', async (c) => {
    const k = kb(t, c);
    await t.keyboard.press('Control+,'); c.keys += 1;
    await t.waitForTimeout(600);
    const dlg = t.getByRole('dialog').first();
    if (!(await dlg.count())) throw new Error('Ctrl+, did not open settings');
    await dlg.getByRole('button', { name: /^Appearance/ }).first().focus();
    await k.press('Enter');
    await t.waitForTimeout(300);
    const zoom = dlg.getByRole('slider', { name: /zoom/i }).first();
    if (!(await zoom.count())) throw new Error('no zoom slider with an accessible name');
    await zoom.focus();
    for (let i = 0; i < 10; i += 1) await k.press('ArrowRight');
    const val = await zoom.evaluate((e) => e.getAttribute('aria-valuenow') || e.value);
    c.issues.push(`zoom now ${val}`);
    await shot(t, 'tom-07-appearance');
    await axe(t, 'settings-appearance');
    await k.press('Escape');
    await t.waitForTimeout(500);
    R.targets.channelZoomed = await targetSizes(t);
    c.issues.push(`after zoom: ${R.targets.channelZoomed.under24}/${R.targets.channelZoomed.total} targets <24px, ${R.targets.channelZoomed.under44} <44px`);
    await shot(t, 'tom-08-zoomed-channel');
    R.reflow.tomZoom = await hScroll(t);
  });

  R.pageErrors = { ...(R.pageErrors || {}), tom: T.page.errors };
}

// ============================================================================
//  Kenji — deuteranopia + dyslexia, Japanese UI. Desktop 1920x1080 then 400% zoom.
// ============================================================================
async function kenji() {
  const who = 'kenji';
  const user = `kenji_${RUN}`;
  const K = await newCtx(browser, { viewport: { width: 1280, height: 800 }, locale: 'ja-JP' });
  const k = K.page;
  globalThis.__curPage = k;

  // Mina goes Do Not Disturb, a third member stays idle-ish: set via status menu.
  await m.getByRole('button', { name: new RegExp(`^${mina}`) }).first().click().catch(() => {});
  await m.getByRole('menuitem', { name: /Do Not Disturb/i }).or(m.getByRole('button', { name: /Do Not Disturb/i })).or(m.getByText(/Do Not Disturb/i)).first().click().catch(() => {});
  await m.keyboard.press('Escape').catch(() => {});

  await task(who, 'switch login to 日本語 via globe', async (c) => {
    await k.goto(BASE + '/');
    await k.waitForLoadState('networkidle');
    const lang0 = await k.evaluate(() => document.documentElement.lang);
    c.issues.push(`initial lang (browser ja-JP) = ${lang0}`);
    await shot(k, 'kenji-01-login-initial');
    if (!/^ja/.test(lang0)) {
      await k.getByRole('button', { name: /Language|言語/ }).first().click(); c.clicks += 1;
      await k.getByRole('option', { name: /日本語/ }).first().click(); c.clicks += 1;
      await k.waitForTimeout(400);
    }
    const lang = await k.evaluate(() => document.documentElement.lang);
    c.issues.push(`lang after = ${lang}; title=${await k.title()}`);
    await shot(k, 'kenji-02-login-ja');
    await axe(k, 'login-ja');
  });

  await task(who, 'register in Japanese; error state readable without colour', async (c) => {
    await k.getByRole('button', { name: /登録|アカウント作成|Sign up/ }).last().click(); c.clicks += 1;
    const inputs = k.locator('form input');
    await inputs.first().fill(user);
    await k.locator('input[type=password]').fill('short');
    await k.locator('form button[type=submit]').click(); c.clicks += 1;
    await k.waitForTimeout(600);
    // Native validation bubble or app error?
    const validity = await k.locator('input[type=password]').evaluate((e) => e.validationMessage);
    c.issues.push(`password validation message: "${validity}"`);
    await shot(k, 'kenji-03-register-error');
    await deutanShot(k, 'kenji-03b-register-error-deutan');
    await k.locator('input[type=password]').fill(PASSWORD);
    await k.locator('form button[type=submit]').click();
    await k.getByRole('navigation').first().waitFor();
    await k.waitForTimeout(800);
    await axe(k, 'home-ja');
  });

  await task(who, 'join via invite; read member list status (deuteranopia sim)', async (c) => {
    await k.goto(inviteUrl);
    await k.locator('button').filter({ hasText: /招待|参加|Accept/ }).first().click(); c.clicks += 1;
    await k.getByText(serverName).first().waitFor();
    await k.waitForTimeout(1200);
    if (await k.locator('[role=dialog]').count()) await k.keyboard.press('Escape');
    await say(m, `Kenji-san, ようこそ! Chapter 7 is next ${RUN}`);
    await k.waitForTimeout(600);
    await shot(k, 'kenji-04-channel-ja');
    await deutanShot(k, 'kenji-05-channel-deutan');
    await axe(k, 'channel-ja');
    // Status dots: colour only? Inspect a member row's accessible name + dot.
    R.color.members = await k.evaluate(() => [...document.querySelectorAll('aside button')].slice(0, 5).map((b) => {
      const dot = b.querySelector('span.rounded-full.absolute, span[class*="rounded-full"][class*="absolute"]');
      return { name: b.getAttribute('aria-label') || b.innerText.replace(/\s+/g, ' ').trim(), dotClass: dot?.className.match(/bg-d-\S+/)?.[0], dotLabel: dot?.getAttribute('aria-label') || dot?.getAttribute('title') || null, dotSize: dot ? Math.round(dot.getBoundingClientRect().width) : null, hasSvgShape: !!dot?.querySelector('svg') };
    }));
    c.issues.push(`member rows: ${JSON.stringify(R.color.members)}`);
    // Crop member list for close look.
    const aside = k.locator('aside').first();
    if (await aside.count()) {
      await aside.screenshot({ path: path.join(SHOTS, 'persona-accessibility-kenji-06-members.png') }).catch(() => {});
      await k.evaluate((mtx) => {
        if (!document.getElementById('__deutan')) {
          const d = document.createElement('div');
          d.innerHTML = `<svg id="__deutan" style="position:absolute;width:0;height:0"><filter id="deutan"><feColorMatrix type="matrix" values="${mtx}"/></filter></svg>`;
          document.body.appendChild(d.firstChild);
        }
        document.documentElement.style.filter = 'url(#deutan)';
      }, DEUTAN);
      await aside.screenshot({ path: path.join(SHOTS, 'persona-accessibility-kenji-06b-members-deutan.png') }).catch(() => {});
      await k.evaluate(() => { document.documentElement.style.filter = ''; });
    }
  });

  await task(who, 'unread + mention indicators without colour', async (c) => {
    // Mina creates a second channel and posts there; Kenji should see it as unread.
    await m.getByRole('button', { name: 'Create text channel' }).or(m.getByTitle('Create text channel')).first().click();
    await m.getByPlaceholder('new-channel').fill('spoilers');
    await m.locator('[role="dialog"]').getByRole('button', { name: /Create channel/ }).click();
    await composer(m).waitFor();
    await say(m, `@${user} spoiler: the narrator did it`);
    await k.waitForTimeout(1200);
    R.color.unread = await k.evaluate(() => [...document.querySelectorAll('#channel-list button, nav button')].filter((b) => /spoilers|general/.test(b.innerText)).map((b) => {
      const cs = getComputedStyle(b.querySelector('span') || b);
      return { name: b.getAttribute('aria-label') || b.innerText.replace(/\s+/g, ' ').trim(), color: cs.color, weight: cs.fontWeight, ariaDesc: b.getAttribute('aria-description') || b.getAttribute('aria-describedby') };
    }));
    c.issues.push(JSON.stringify(R.color.unread));
    await shot(k, 'kenji-07-unread');
    await deutanShot(k, 'kenji-07b-unread-deutan');
    const sb = k.locator('#channel-list').first();
    if (await sb.count()) await sb.screenshot({ path: path.join(SHOTS, 'persona-accessibility-kenji-07c-sidebar.png') }).catch(() => {});
  });

  await task(who, 'reduced motion (OS setting) respected', async (c) => {
    await k.emulateMedia({ reducedMotion: 'reduce' });
    await k.waitForTimeout(300);
    const anim = await k.evaluate(() => {
      const moving = [];
      for (const e of document.querySelectorAll('*')) {
        const cs = getComputedStyle(e);
        const dur = parseFloat(cs.animationDuration) || 0;
        const tdur = parseFloat(cs.transitionDuration) || 0;
        if ((cs.animationName !== 'none' && dur > 0.01 && cs.animationIterationCount === 'infinite')) moving.push(`${e.tagName}.${String(e.className).slice(0, 40)} anim ${cs.animationName} ${dur}s`);
        else if (tdur > 0.2) moving.push(`${e.tagName}.${String(e.className).slice(0, 30)} transition ${tdur}s`);
      }
      return moving.slice(0, 15);
    });
    R.color.reducedMotionLeftovers = anim;
    c.issues.push(`animations/transitions still >0.2s under prefers-reduced-motion: ${anim.length}`);
    // Typing indicator bounce under reduce
    const box = composer(m); await box.click(); await box.pressSequentially('kenji...', { delay: 50 });
    await k.waitForTimeout(800);
    const bounce = await k.evaluate(() => [...document.querySelectorAll('.animate-bounce')].map((e) => getComputedStyle(e).animationName + ' ' + getComputedStyle(e).animationDuration));
    c.issues.push(`typing dots under reduce: ${JSON.stringify(bounce)}`);
    await box.fill('');
  });

  await task(who, 'WCAG 1.4.12 text spacing (ja UI)', async (c) => {
    const before = await clippedText(k);
    await k.addStyleTag({ content: TEXT_SPACING_CSS });
    await k.waitForTimeout(300);
    const after = await clippedText(k);
    R.reflow.textSpacing = { before, after };
    c.issues.push(`clipped text elements: ${before.count} → ${after.count}; new: ${after.sample.filter((x) => !before.sample.includes(x)).slice(0, 10).join(' | ')}`);
    await shot(k, 'kenji-08-text-spacing');
    await k.reload(); await k.waitForLoadState('networkidle'); await k.waitForTimeout(800);
  });

  await task(who, '400% zoom reflow (320 CSS px wide)', async (c) => {
    await k.setViewportSize({ width: 320, height: 256 });
    await k.waitForTimeout(800);
    R.reflow.zoom400 = await hScroll(k);
    await shot(k, 'kenji-09-reflow-400');
    await axe(k, 'channel-ja-320px');
    const composerVisible = await composer(k).isVisible().catch(() => false);
    const vis = await composer(k).boundingBox().catch(() => null);
    c.issues.push(`h-overflow=${R.reflow.zoom400.overflow} (docW ${R.reflow.zoom400.docW}); composer visible=${composerVisible} box=${JSON.stringify(vis)}`);
    // Can he still open the channel list?
    const menuBtn = k.getByRole('button', { name: /チャンネル|menu|メニュー|サーバー|Open/i }).first();
    c.issues.push(`hamburger/menu button=${await menuBtn.count() ? await menuBtn.getAttribute('aria-label') : 'none'}`);
    await k.setViewportSize({ width: 480, height: 270 });
    await k.waitForTimeout(500);
    await shot(k, 'kenji-10-reflow-300pct');
    await k.setViewportSize({ width: 1280, height: 800 });
  });

  await task(who, 'readability: fonts, line length, sizes in ja', async (c) => {
    const f = await k.evaluate(() => {
      const msg = [...document.querySelectorAll('[id^="message-"]:not(#message-composer)')].pop();
      const p = msg?.querySelector('[class*="markdown"], p, div > span') || msg;
      const cs = getComputedStyle(p);
      const tiny = [...document.querySelectorAll('body *')].filter((e) => e.childElementCount === 0 && e.innerText?.trim() && e.getClientRects().length && parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${e.innerText.trim().slice(0, 20)}(${getComputedStyle(e).fontSize})`);
      return { font: cs.fontFamily, size: cs.fontSize, lh: cs.lineHeight, bodyFont: getComputedStyle(document.body).fontFamily, tinyCount: tiny.length, tiny: [...new Set(tiny)].slice(0, 20), uppercaseHeaders: [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).textTransform === 'uppercase' && e.innerText?.trim() && e.childElementCount === 0).slice(0, 8).map((e) => e.innerText.trim()) };
    });
    R.color.readability = f;
    c.issues.push(JSON.stringify(f).slice(0, 600));
    await k.getByRole('button', { name: /ユーザー設定|User settings/ }).first().click();
    await k.waitForTimeout(500);
    await shot(k, 'kenji-11-settings-ja');
    await axe(k, 'settings-ja');
    await k.getByRole('button', { name: /アクセシビリティ|Accessibility/ }).first().click();
    await k.waitForTimeout(400);
    await shot(k, 'kenji-12-a11y-ja');
    await deutanShot(k, 'kenji-12b-a11y-ja-deutan');
    await axe(k, 'settings-a11y-ja');
    const untranslated = await k.evaluate(() => {
      const d = document.querySelector('[role=dialog]');
      return [...(d?.querySelectorAll('*') ?? [])].filter((e) => e.childElementCount === 0 && /^[A-Za-z][A-Za-z ,.'&-]{6,}$/.test(e.innerText?.trim() ?? '')).map((e) => e.innerText.trim()).slice(0, 25);
    });
    R.color.untranslatedInA11ySettings = untranslated;
    c.issues.push(`English strings left in ja settings: ${untranslated.length} (${untranslated.slice(0, 8).join(' | ')})`);
    await k.keyboard.press('Escape');
  });

  R.pageErrors = { ...(R.pageErrors || {}), kenji: K.page.errors };
}
