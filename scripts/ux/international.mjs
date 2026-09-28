#!/usr/bin/env node
// ============================================================================
//  UX persona scenario — "international" group.
//
//  Six non-English personas (ja, ru, ko, de, zh-TW, pl) plus a Thai friend
//  use the app in their own language on their own device. The browser's
//  language list drives locale detection (like a real first visit), and every
//  label is looked up from src/i18n/locales/<code>.js so the scenario is
//  independent of wording.
//
//  Collects: screenshots per step, automatic truncation/overflow detection
//  (elements whose text is clipped: scrollWidth > clientWidth with
//  overflow:hidden, or text leaking out of the viewport), untranslated English
//  strings left in the UI, date/number formats, and search results for
//  non-Latin queries.
//
//  Usage: UX_BASE=http://localhost:7060 node scripts/ux/international.mjs [persona…]
//  (the server must already be running — see scripts/e2e/run.mjs for env).
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.UX_BASE || 'http://localhost:7060';
const SHOTS = process.env.UX_SHOTS
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';
const OUT = process.env.UX_OUT || path.join(SHOTS, 'persona-international-findings.json');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const RUN = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'correct-horse-battery-9';
fs.mkdirSync(SHOTS, { recursive: true });

const en = (await import(path.join(ROOT, 'src/i18n/en.js'))).default;
async function dict(code) {
  if (code === 'en') return en;
  const file = code === 'th' ? 'src/i18n/th.js' : `src/i18n/locales/${code}.js`;
  return (await import(path.join(ROOT, file))).default;
}

export const PERSONAS = {
  dmitri: { name: 'Dmitri', code: 'ru', langs: ['ru-RU', 'ru', 'en'], viewport: { width: 1440, height: 900 }, dpr: 2,
    user: `dmitri_${RUN}`, display: 'Дмитрий Соколов', tz: 'Europe/Moscow',
    msgs: ['Привет всем! Новый макет логотипа готов — посмотрите, пожалуйста.', 'Шрифт в заголовке — Гротеск, 24 пт. Выглядит отлично?'],
    search: 'макет' },
  yuki: { name: 'Yuki', code: 'ja', langs: ['ja-JP', 'ja'], viewport: { width: 412, height: 915 }, dpr: 2.625, mobile: true,
    user: `yuki_${RUN}`, display: '佐藤ゆき', tz: 'Asia/Tokyo',
    msgs: ['こんにちは！今日の会議は15時からです。よろしくお願いします。', '了解です🙆‍♀️ 資料は後で共有しますね。'],
    search: '会議' },
  jiwoo: { name: 'Ji-woo', code: 'ko', langs: ['ko-KR', 'ko'], viewport: { width: 390, height: 844 }, dpr: 3, mobile: true,
    user: `jiwoo_${RUN}`, display: '김지우', tz: 'Asia/Seoul',
    msgs: ['안녕하세요! 내일 스터디 몇 시에 해요?', 'ㅋㅋㅋ 저는 도서관에 있어요 📚'],
    search: '스터디' },
  hans: { name: 'Hans', code: 'de', langs: ['de-DE', 'de'], viewport: { width: 1280, height: 720 }, dpr: 1.25,
    user: `hans_${RUN}`, display: 'Hans Müller (DL1ABC)', tz: 'Europe/Berlin',
    msgs: ['Guten Abend zusammen! Nächste Funkrunde am Donnerstag um 19:30 Uhr auf 145,500 MHz.', 'Übertragungsgeschwindigkeitsbegrenzungsüberschreitung — schönes Wort, oder?'],
    search: 'Funkrunde' },
  wei: { name: 'Wei', code: 'zh-TW', langs: ['zh-TW', 'zh-Hant', 'zh'], viewport: { width: 1920, height: 1080 }, dpr: 1,
    user: `wei_${RUN}`, display: '陳偉', tz: 'Asia/Taipei',
    msgs: ['大家好！週末要不要一起去夜市吃東西？', '我在台北車站附近，晚上七點見 👍'],
    search: '夜市' },
  olga: { name: 'Olga', code: 'pl', langs: ['pl-PL', 'pl'], viewport: { width: 1366, height: 768 }, dpr: 1,
    user: `olga_${RUN}`, display: 'Olga Wiśniewska', tz: 'Europe/Warsaw',
    msgs: ['Dzień dobry! Źdźbło trawy, żółć, gęślą jaźń — sprawdzam polskie znaki.', 'Mam 1 nową wiadomość, 2 nowe wiadomości, 5 nowych wiadomości.'],
    search: 'źdźbło' },
  somchai: { name: 'Somchai', code: 'th', langs: ['th-TH', 'th'], viewport: { width: 412, height: 915 }, dpr: 2.625, mobile: true,
    user: `somchai_${RUN}`, display: 'สมชาย ใจดี', tz: 'Asia/Bangkok',
    msgs: ['สวัสดีครับทุกคน! ผู้ใหญ่ ปั้นน้ำเป็นตัว ฤๅษี ญี่ปุ่น ฎีกา ฏ ฐ — ทดสอบสระและวรรณยุกต์ ปิ๊ป ป๊อป กี่ ก๋วยเตี๋ยว', 'I am Thai, こんにちは also! ผมพูดไทย English 日本語 ได้นิดหน่อย'],
    search: 'ก๋วยเตี๋ยว' }
};

const findings = { run: RUN, personas: {} };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);

export async function makeUser(browser, key) {
  const p = PERSONAS[key];
  const d = await dict(p.code);
  const t = (k, vars = {}) => String(d[k] ?? en[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? `{${v}}`);
  const ctx = await browser.newContext({
    viewport: p.viewport, deviceScaleFactor: p.dpr, isMobile: !!p.mobile, hasTouch: !!p.mobile,
    locale: p.langs[0], timezoneId: p.tz,
    extraHTTPHeaders: { 'Accept-Language': p.langs.join(',') }
  });
  await ctx.addInitScript((langs) => {
    Object.defineProperty(navigator, 'languages', { get: () => langs });
  }, p.langs);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const log = (findings.personas[key] ??= { name: p.name, code: p.code, shots: [], overflow: [], english: [], notes: [], errors: [] });
  page.on('pageerror', (e) => log.errors.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') log.errors.push(m.text().slice(0, 200)); });
  let n = 0;
  const shot = async (name, opts = {}) => {
    const file = path.join(SHOTS, `persona-international-${key}-${String(++n).padStart(2, '0')}-${slug(name)}.png`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: file, ...opts }).catch(() => {});
    log.shots.push(file);
    return file;
  };
  // Clipped / overflowing text detection.
  const audit = async (where) => {
    const res = await page.evaluate(() => {
      const out = [];
      const vw = document.documentElement.clientWidth;
      for (const el of document.querySelectorAll('body *')) {
        if (!el.childNodes.length) continue;
        const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim();
        if (!own) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        let kind = null;
        if (el.scrollWidth > el.clientWidth + 1 && (cs.overflowX === 'hidden' || cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis')) kind = 'truncated-x';
        else if (el.scrollHeight > el.clientHeight + 2 && cs.overflowY === 'hidden' && !/scroll|auto/.test(cs.overflowY)) kind = 'clipped-y';
        else if (r.right > vw + 1) kind = 'offscreen';
        if (kind) out.push({ kind, text: own.slice(0, 80), w: Math.round(r.width), sw: el.scrollWidth, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80) });
      }
      return out;
    });
    for (const r of res) log.overflow.push({ where, ...r });
    return res;
  };
  // English leftovers: visible text that exactly equals an English source string
  // (and differs from this locale's translation).
  const enValues = new Map();
  for (const [k, v] of Object.entries(en)) if (typeof v === 'string' && v.length > 3 && /[a-z]/i.test(v) && !v.includes('{') && d[k] !== v) enValues.set(v.trim(), k);
  const englishLeft = async (where) => {
    if (p.code === 'en') return [];
    const texts = await page.evaluate(() => {
      const s = new Set();
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) { const v = w.currentNode.textContent.trim(); if (v) s.add(v); }
      for (const el of document.querySelectorAll('[title],[aria-label],[placeholder]')) for (const a of ['title', 'aria-label', 'placeholder']) { const v = el.getAttribute(a); if (v) s.add(v.trim()); }
      return [...s];
    });
    const hits = texts.filter((x) => enValues.has(x)).map((x) => ({ where, text: x, key: enValues.get(x) }));
    log.english.push(...hits);
    return hits;
  };
  const note = (s) => { log.notes.push(s); console.log(`   [${key}] ${s}`); };
  return { key, p, ctx, page, t, d, shot, audit, englishLeft, note, log };
}

export async function register(u) {
  const { page, t, p } = u;
  await page.goto(BASE + '/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await u.shot('login-cold-start');
  await u.audit('login'); await u.englishLeft('login');
  await page.getByRole('button', { name: t('auth.register') }).first().click();
  await page.waitForTimeout(300);
  await u.shot('register-form');
  await u.audit('register');
  await page.getByLabel(t('auth.username'), { exact: false }).first().fill(p.user);
  const dn = page.getByLabel(t('auth.displayName'), { exact: false });
  if (await dn.count()) await dn.first().fill(p.display);
  await page.getByLabel(new RegExp('^' + t('auth.password'))).first().fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await page.getByRole('navigation', { name: t('sidebar.servers') }).first().waitFor({ timeout: 12000 });
  await page.waitForTimeout(800);
  await u.shot('home-after-register');
  await u.audit('home'); await u.englishLeft('home');
}


async function step(u, name, fn) {
  const t0 = Date.now();
  try { await fn(); u.log.steps = [...(u.log.steps ?? []), { name, ok: true, ms: Date.now() - t0 }]; console.log(`  PASS [${u.key}] ${name} ${Date.now() - t0}ms`); }
  catch (e) {
    u.log.steps = [...(u.log.steps ?? []), { name, ok: false, ms: Date.now() - t0, err: String(e.message).split('\n')[0].slice(0, 200) }];
    console.log(`  FAIL [${u.key}] ${name}: ${String(e.message).split('\n')[0].slice(0, 200)}`);
    await u.shot('FAIL-' + name);
  }
}

/** Which font files actually rendered some sample text (CDP). */
export async function fontsUsed(u, selector, label) {
  const cdp = await u.ctx.newCDPSession(u.page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
  const agg = {};
  for (const id of nodeIds.slice(0, 40)) {
    try {
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: id });
      for (const f of fonts) agg[f.familyName] = (agg[f.familyName] ?? 0) + f.glyphCount;
    } catch { /* node gone */ }
  }
  (u.log.fonts ??= {})[label] = agg;
  return agg;
}

const composer = (page) => page.locator('textarea[aria-label], [role="textbox"][contenteditable]').last();

async function openServerRail(u) {
  // On phones the server rail/channel list is behind a drawer.
  const nav = u.page.getByRole('navigation', { name: u.t('sidebar.servers') }).first();
  if (await nav.isVisible().catch(() => false)) return;
  const menu = u.page.getByRole('button', { name: new RegExp(u.t('mobile.openNav') + '|' + u.t('chat.openSidebar') + '|menu', 'i') }).first();
  if (await menu.count()) await menu.click();
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-proxy-server', '--disable-background-networking', '--disable-component-update'] });
  const serverName = { ru: 'Клуб дизайнеров «Шрифт»' };
  const U = {};
  for (const k of Object.keys(PERSONAS)) U[k] = await makeUser(browser, k);
  for (const k of Object.keys(U)) await step(U[k], 'register', () => register(U[k]));

  // --- owner (Dmitri) creates the international server ------------------------
  const own = U.dmitri; const a = own.page; let invite = '';
  const SERVER = 'Международный клуб 🌏 国際 국제';
  await step(own, 'create server', async () => {
    await a.getByRole('button', { name: own.t('server.addServer') }).first().click();
    await own.shot('add-server-dialog'); await own.audit('add-server');
    await a.getByRole('button', { name: new RegExp(own.t('server.createOwn')) }).click();
    await a.getByPlaceholder(own.t('server.namePlaceholder')).fill(SERVER);
    await own.shot('create-server-form'); await own.audit('create-server');
    await a.getByRole('button', { name: new RegExp('^' + own.t('common.create') + '$') }).last().click();
    await a.waitForFunction(() => /\/invite\//.test(document.getElementById('invite-link')?.value ?? ''), null, { timeout: 8000 });
    invite = await a.locator('#invite-link').inputValue();
    await own.shot('invite-offer'); await own.audit('invite-offer'); await own.englishLeft('invite-offer');
    await a.keyboard.press('Escape');
  });
  await step(own, 'create cyrillic channel', async () => {
    await a.getByTitle(own.t('sidebar.createTextChannel')).or(a.getByRole('button', { name: own.t('sidebar.createTextChannel') })).first().click();
    await a.getByPlaceholder(own.t('channel.namePlaceholder')).fill('Обсуждение макетов');
    await own.shot('create-channel-cyrillic');
    await a.locator('[role=dialog]').getByRole('button', { name: new RegExp(own.t('server.createChannel')) }).click();
    await a.waitForTimeout(800);
    await own.shot('channel-created');
    const names = await a.locator('nav, aside').allInnerTexts();
    own.note('channel sidebar text after cyrillic channel create: ' + JSON.stringify(names.join(' | ').slice(0, 300)));
  });
  findings.invite = invite;
  console.log('invite', invite);

  // --- everyone joins and posts --------------------------------------------
  for (const k of Object.keys(U)) {
    if (k === 'dmitri') continue;
    const u = U[k];
    await step(u, 'join via invite', async () => {
      await u.page.goto(invite);
      await u.page.waitForTimeout(1200);
      await u.shot('invite-landing'); await u.audit('invite-landing'); await u.englishLeft('invite-landing');
      await u.page.getByRole('button', { name: new RegExp(u.t('invites.acceptInvite')) }).first().click();
      await u.page.waitForTimeout(1500);
      await u.shot('after-join'); await u.audit('after-join'); await u.englishLeft('after-join');
    });
  }
  // conversation: interleave
  const order = ['dmitri', 'yuki', 'somchai', 'jiwoo', 'hans', 'wei', 'olga', 'somchai', 'dmitri', 'yuki', 'jiwoo', 'hans', 'wei', 'olga'];
  const idx = {};
  for (const k of order) {
    const u = U[k];
    const i = (idx[k] = (idx[k] ?? -1) + 1);
    if (!u.p.msgs[i]) continue;
    await step(u, 'send msg ' + i, async () => {
      const general = u.page.getByText('general', { exact: true }).first();
      const box = composer(u.page);
      if (!(await box.isVisible().catch(() => false)) || u.p.mobile) {
        if (await general.isVisible().catch(() => false)) { await general.click(); await u.page.waitForTimeout(500); }
        if (i === 0) { await u.shot('mobile-channel-open'); await u.audit('channel-open'); }
      }
      await box.click();
      await box.fill(u.p.msgs[i]);
      await box.press('Enter');
      await u.page.waitForTimeout(400);
    });
  }
  await new Promise((r) => setTimeout(r, 1500));
  for (const k of Object.keys(U)) {
    const u = U[k];
    await step(u, 'read mixed chat', async () => {
      await u.page.waitForTimeout(500);
      await u.shot('mixed-language-chat'); await u.audit('chat'); await u.englishLeft('chat');
      await fontsUsed(u, '[id^="message-"] *', 'messages');
      await fontsUsed(u, 'nav *, aside *, header *', 'chrome');
      const stamp = await u.page.locator('[id^="message-"] time, [id^="message-"] [datetime]').allInnerTexts().catch(() => []);
      u.note('timestamps: ' + JSON.stringify(stamp.slice(0, 4)));
      const tt = await u.page.locator('[id^="message-"] time').first().getAttribute('title').catch(() => null);
      u.note('timestamp tooltip: ' + tt);
    });
    await step(u, 'search non-latin', async () => {
      const s = u.page.getByPlaceholder(u.t('common.search')).first();
      await s.click(); await s.fill(u.p.search); await s.press('Enter');
      await u.page.waitForTimeout(1500);
      await u.shot('search-' + u.p.code); await u.audit('search'); await u.englishLeft('search');
      const body = await u.page.locator('body').innerText();
      const hits = body.split(u.p.search).length - 1;
      u.note(`search "${u.p.search}" → occurrences on page after search: ${hits}`);
      await u.page.keyboard.press('Escape');
    });
  }
  fs.writeFileSync(OUT, JSON.stringify(findings, null, 2));
  globalThis.__U = U;
  if (process.env.UX_PHASE2 !== '0') await phase2(U);
  fs.writeFileSync(OUT, JSON.stringify(findings, null, 2));
  await browser.close();
}


export const USER_TABS = ['settings.profileTab', 'settings.accountTab', 'settings.privacyTab', 'settings.activityTab', 'settings.appearanceTab',
  'settings.accessibilityTab', 'settings.voiceTab', 'settings.notificationsTab', 'settings.keybindsTab', 'settings.chatTab', 'settings.streamerTab'];
export const SERVER_TABS = ['settings.overview', 'settings.roles', 'settings.channelPermissions', 'chat.emoji', 'settings.stickers', 'settings.soundboard',
  'settings.webhooks', 'settings.automod', 'settings.reports', 'settings.auditLog', 'settings.bans', 'settings.onboarding', 'settings.insights',
  'autocomplete.members', 'settings.invites'];

export async function tabs(u, dialogName, keys, prefix) {
  const dlg = u.page.getByRole('dialog').last();
  for (const k of keys) {
    const label = u.t(k);
    const btn = dlg.getByRole('button', { name: label, exact: true }).or(dlg.getByRole('tab', { name: label, exact: true })).first();
    if (!(await btn.count())) { u.note(`${prefix}: tab "${label}" (${k}) not found`); continue; }
    await btn.click().catch(() => {});
    await u.page.waitForTimeout(450);
    const hits = await u.audit(`${prefix}:${k}`);
    await u.englishLeft(`${prefix}:${k}`);
    if (hits.length || ['settings.appearanceTab', 'settings.overview', 'settings.roles', 'settings.accountTab', 'settings.notificationsTab', 'settings.automod', 'settings.invites', 'settings.insights'].includes(k)) {
      await u.shot(`${prefix}-${k}`);
    }
    if (u.p.mobile) { // phone settings is a stack: go back to the list
      const back = u.page.getByRole('button', { name: new RegExp(u.t('common.back') + '|back', 'i') }).first();
      if (await back.isVisible().catch(() => false)) await back.click().catch(() => {});
    }
  }
}

async function phase2(U) {
  for (const k of Object.keys(U)) {
    const u = U[k];
    const pg = u.page;
    await step(u, 'message context menu', async () => {
      const row = pg.locator('[id^="message-"]').last();
      if (u.p.mobile) { await row.click({ delay: 700 }).catch(() => {}); } // long-press-ish
      else { await row.hover(); await u.shot('message-hover-actions'); await u.audit('hover-actions'); await row.click({ button: 'right' }); }
      await pg.waitForTimeout(400);
      await u.shot('message-context-menu'); await u.audit('context-menu'); await u.englishLeft('context-menu');
      await pg.keyboard.press('Escape');
      const tt = await row.locator('time').first().getAttribute('title').catch(() => null)
        ?? await row.locator('[title]').first().getAttribute('title').catch(() => null);
      u.note('hover time tooltip: ' + tt);
    });
    await step(u, 'user settings tabs', async () => {
      if (u.p.mobile) await openServerRail(u);
      await pg.getByRole('button', { name: u.t('sidebar.userSettings') }).first().click();
      await pg.waitForTimeout(600);
      await u.shot('user-settings-open'); await u.audit('user-settings'); await u.englishLeft('user-settings');
      await tabs(u, 'user', USER_TABS, 'user-settings');
      await pg.keyboard.press('Escape');
      await pg.waitForTimeout(300);
    });
    if (k === 'dmitri' || k === 'hans' || k === 'olga') {
      // Owner opens server settings; Hans/Olga see as members what they can.
      await step(u, 'server settings tabs', async () => {
        await pg.getByText(/Международный клуб/).first().click();
        await pg.waitForTimeout(400);
        await u.shot('server-dropdown'); await u.audit('server-dropdown'); await u.englishLeft('server-dropdown');
        const item = pg.getByRole('menuitem', { name: u.t('server.settings') }).first();
        if (!(await item.count())) { u.note('no server settings item (not permitted)'); await pg.keyboard.press('Escape'); return; }
        await item.click();
        await pg.waitForTimeout(600);
        await tabs(u, 'server', SERVER_TABS, 'server-settings');
        await pg.keyboard.press('Escape');
      });
    }
  }
  // Language picker on the login screen + switching language live (Hans → Thai → back)
  const h = U.hans;
  await step(h, 'language picker', async () => {
    const ctx2 = await h.ctx.browser().newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, locale: 'de-DE' });
    const p2 = await ctx2.newPage();
    await p2.goto(BASE + '/'); await p2.waitForTimeout(800);
    await p2.getByRole('button', { name: /Deutsch/ }).first().click();
    await p2.waitForTimeout(400);
    const file = path.join(SHOTS, 'persona-international-hans-lang-picker-mobile.png');
    await p2.screenshot({ path: file }); h.log.shots.push(file);
    await ctx2.close();
  });
}


if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
