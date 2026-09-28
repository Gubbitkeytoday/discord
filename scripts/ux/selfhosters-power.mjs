#!/usr/bin/env node
// ============================================================================
//  UX persona scenario: "selfhosters-power" (Sam, Niran, Eve).
//
//  Drives an ALREADY RUNNING server (boot it like scripts/e2e/run.mjs, or follow
//  README "Minimal bare-metal run" in a fresh clone) and records time / clicks /
//  outcome per task plus screenshots.
//
//  Usage:  UX_BASE=http://localhost:7080 [UX_LAN=http://192.0.2.2:7080] \
//          node scripts/ux/selfhosters-power.mjs [sam|eve|all]
//  Env:    CHROMIUM_PATH (default /opt/pw-browsers/chromium), UX_SHOTS
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';

const BASE = process.env.UX_BASE || 'http://localhost:7080';
const LAN = process.env.UX_LAN || '';
const SHOTS = process.env.UX_SHOTS
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const RUN = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'correct-horse-battery-9';
const which = process.argv[2] || 'all';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const notes = [];
const note = (who, text) => { notes.push(`[${who}] ${text}`); console.log(`   · ${who}: ${text}`); };
async function task(who, name, fn) {
  const t0 = Date.now();
  const counter = { clicks: 0 };
  try {
    const extra = await fn(counter);
    results.push({ who, name, ok: true, s: ((Date.now() - t0) / 1000).toFixed(1), clicks: counter.clicks, extra });
    console.log(`PASS [${who}] ${name} ${((Date.now() - t0) / 1000).toFixed(1)}s ${extra ?? ''}`);
  } catch (err) {
    results.push({ who, name, ok: false, s: ((Date.now() - t0) / 1000).toFixed(1), clicks: counter.clicks, err: String(err.message).split('\n')[0] });
    console.log(`FAIL [${who}] ${name}: ${String(err.message).split('\n')[0]}`);
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `persona-selfhosters-power-${name}.png`) }).catch(() => {});
const composer = (page) => page.locator('textarea[aria-label^="Message"], [role="textbox"][aria-label^="Message"]').first();
const msgRow = (page, text) => page.locator('[id^="message-"]').filter({ hasText: text });
const visible = (loc, timeout = 8000) => loc.first().waitFor({ state: 'visible', timeout });

async function newCtx(browser, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, ...opts });
  await context.route((u) => !u.href.startsWith(BASE) && !(LAN && u.href.startsWith(LAN)) && /^https?:/.test(u.href), (r) => r.abort());
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: net::ERR_FAILED/.test(m.text())) page.errors.push(m.text()); });
  return { context, page };
}

async function register(page, origin, username, c) {
  await page.goto(origin + '/');
  await page.getByRole('button', { name: 'Sign up' }).click(); c.clicks++;
  await page.getByLabel(/Username/).fill(username);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.locator('form button[type=submit]').click(); c.clicks++;
}

async function createServer(page, name, c) {
  await page.getByRole('button', { name: 'Add a server' }).click(); c.clicks++;
  await page.getByRole('button', { name: /Create my own/ }).click(); c.clicks++;
  const box = page.getByPlaceholder('e.g. Chill Squad HQ');
  await box.fill(name);
  await page.getByRole('button', { name: /^Create$/ }).click(); c.clicks++;
  await visible(page.getByText(name));
}

async function sam(browser) {
  const who = 'Sam';
  // 1) LAN IP over plain http with SECURE_COOKIES=1 (what README's minimal block says)
  if (LAN) {
    const { page, context } = await newCtx(browser);
    await task(who, 'register via LAN IP over http (SECURE_COOKIES=1)', async (c) => {
      await register(page, LAN, `sam_lan_${RUN}`, c);
      await page.waitForTimeout(2500);
      await shot(page, 'sam-lan-register');
      const inApp = await page.getByRole('navigation', { name: 'Servers' }).isVisible().catch(() => false);
      const cookies = await context.cookies();
      await page.reload();
      await page.waitForTimeout(2000);
      await shot(page, 'sam-lan-after-reload');
      const stillIn = await page.getByRole('navigation', { name: 'Servers' }).isVisible().catch(() => false);
      const body = (await page.locator('body').innerText()).slice(0, 300).replace(/\s+/g, ' ');
      note(who, `LAN http: inApp=${inApp} cookies=${cookies.map((k) => `${k.name}${k.secure ? '(secure)' : ''}`).join(',')} afterReload=${stillIn} body="${body}"`);
      if (!stillIn) throw new Error(`session lost after reload (inApp=${inApp})`);
    });
    await context.close();
  }

  // 2) localhost cold start → server → invite → friend joins → first message
  const A = await newCtx(browser);
  const B = await newCtx(browser, { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const a = A.page; const b = B.page;
  const serverName = `Friends ${RUN}`;
  let invite;
  const tStart = Date.now();
  await task(who, 'first-run: land on page, understand what it is', async () => {
    await a.goto(BASE + '/');
    await a.waitForTimeout(800);
    await shot(a, 'sam-first-load');
    const text = (await a.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);
    note(who, `landing text: "${text}"`);
    const title = await a.title();
    note(who, `document.title="${title}"`);
  });
  await task(who, 'register first account (is there an admin/owner setup?)', async (c) => {
    await register(a, BASE, `sam_${RUN}`, c);
    await visible(a.getByRole('navigation', { name: 'Servers' }));
    await a.waitForTimeout(800);
    await shot(a, 'sam-after-register');
    const txt = (await a.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);
    note(who, `after register: "${txt}"`);
  });
  await task(who, 'create server for friend group', async (c) => {
    await createServer(a, serverName, c);
    await a.waitForTimeout(800);
    await shot(a, 'sam-server-created');
  });
  await task(who, 'get invite link', async (c) => {
    const dlg = a.getByRole('dialog', { name: /Invite friends/ });
    if (!(await dlg.isVisible().catch(() => false))) {
      await a.getByText(serverName).first().click(); c.clicks++;
      await a.getByRole('menuitem', { name: 'Invite people' }).or(a.getByRole('button', { name: 'Invite people' })).first().click(); c.clicks++;
    }
    await a.waitForFunction(() => /\/invite\//.test(document.getElementById('invite-link')?.value ?? ''), null, { timeout: 8000 });
    invite = await dlg.getByLabel('Invite link').inputValue();
    await shot(a, 'sam-invite-dialog');
    note(who, `invite url = ${invite} (PUBLIC_URL drives this)`);
    await a.keyboard.press('Escape');
  });
  await task(who, 'friend (phone) opens invite, registers, joins', async (c) => {
    const url = invite.replace(/^https?:\/\/[^/]+/, BASE);
    await b.goto(url);
    await b.waitForTimeout(1000);
    await shot(b, 'sam-friend-invite-logged-out');
    const txt = (await b.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
    note(who, `friend sees (logged out): "${txt}"`);
    // If the invite screen asks to sign up first, do it.
    const signup = b.getByRole('button', { name: 'Sign up' });
    if (await signup.isVisible().catch(() => false)) {
      await signup.click(); c.clicks++;
      await b.getByLabel(/Username/).fill(`friend_${RUN}`);
      await b.getByLabel(/^Password/).fill(PASSWORD);
      await b.locator('form button[type=submit]').click(); c.clicks++;
    }
    await b.waitForTimeout(1500);
    await shot(b, 'sam-friend-after-signup');
    const accept = b.getByRole('button', { name: /Accept invite/ });
    if (await accept.isVisible().catch(() => false)) { await accept.click(); c.clicks++; }
    else note(who, 'after signup the invite was NOT resumed automatically; friend had to reopen the link');
    await b.waitForTimeout(1500);
    await shot(b, 'sam-friend-joined');
  });
  await task(who, 'time-to-first-message (owner → friend sees it)', async () => {
    const box = composer(a);
    await box.click();
    await box.fill('hi friends, welcome to our own server!');
    await box.press('Enter');
    await visible(msgRow(a, 'welcome to our own server'));
    const seen = await msgRow(b, 'welcome to our own server').first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);
    await shot(b, 'sam-friend-sees-first-message');
    return `friend sees=${seen}, ${((Date.now() - tStart) / 1000).toFixed(0)}s since landing`;
  });
  await task(who, 'look for instance admin (who can register? disable signups?)', async (c) => {
    await a.getByRole('button', { name: /User settings|Settings/ }).first().click().catch(() => {}); c.clicks++;
    await a.waitForTimeout(800);
    await shot(a, 'sam-user-settings');
    const txt = (await a.locator('[role="dialog"]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600);
    note(who, `settings nav: "${txt}"`);
    await a.keyboard.press('Escape');
  });
  note(who, `errors: A=${a.errors.slice(0, 3).join(' | ')} B=${b.errors.slice(0, 3).join(' | ')}`);
  await A.context.close(); await B.context.close();
}

async function eve(browser) {
  const who = 'Eve';
  const E = await newCtx(browser, { viewport: { width: 1920, height: 1080 } });
  const F = await newCtx(browser);
  const e = E.page; const f = F.page;
  const srv1 = `Work ${RUN}`; const srv2 = `Games ${RUN}`;
  const chans = ['frontend', 'backend', 'random', 'deploys'];
  let invite;
  const kb = (combo) => e.keyboard.press(combo);
  const activeInfo = () => e.evaluate(() => {
    const a = document.activeElement;
    return `${a?.tagName}${a?.id ? '#' + a.id : ''}[${a?.getAttribute('aria-label') ?? a?.getAttribute('role') ?? ''}] "${(a?.innerText ?? a?.value ?? '').slice(0, 40).replace(/\s+/g, ' ')}"`;
  });
  const header = async () => (await e.locator('main h1, main h2, header h1, header h2, [data-channel-header], h1').first().innerText().catch(() => '?')).slice(0, 60);
  const url = async () => (await composer(e).getAttribute('aria-label').catch(() => '?')).replace('Message ', '');

  await task(who, 'setup: register, 2 servers, 4 channels, friend joins', async (c) => {
    await register(e, BASE, `eve_${RUN}`, c);
    await visible(e.getByRole('navigation', { name: 'Servers' }));
    await createServer(e, srv1, c);
    const dlg = e.getByRole('dialog', { name: /Invite friends/ });
    await e.waitForFunction(() => /\/invite\//.test(document.getElementById('invite-link')?.value ?? ''), null, { timeout: 8000 });
    invite = await dlg.getByLabel('Invite link').inputValue();
    await kb('Escape');
    for (const ch of chans) {
      await e.getByRole('button', { name: 'Create text channel' }).or(e.getByTitle('Create text channel')).first().click();
      await e.getByPlaceholder('new-channel').fill(ch);
      await e.locator('[role="dialog"]').getByRole('button', { name: /Create channel/ }).click();
      await e.waitForTimeout(400);
    }
    await createServer(e, srv2, c);
    await kb('Escape');
    await register(f, BASE, `finn_${RUN}`, c);
    await visible(f.getByRole('navigation', { name: 'Servers' }));
    await f.goto(invite.replace(/^https?:\/\/[^/]+/, BASE));
    await f.getByRole('button', { name: /Accept invite/ }).click();
    await visible(f.getByText(srv1));
  });

  const inWork = async () => { await e.getByRole('navigation', { name: 'Servers' }).getByText('WF').first().click().catch(async () => { await e.getByTitle(srv1).first().click(); }); await e.waitForTimeout(500); };
  const switcherItems = async () => (await e.locator('[role="dialog"] li, [role="dialog"] [role="option"], [role="dialog"] button').allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8);
  await task(who, 'Ctrl+K from ANOTHER server → "back" (#backend lives in Work)', async (c) => {
    await e.locator('body').click({ position: { x: 900, y: 500 } }).catch(() => {});
    await kb('Control+K'); c.clicks++;
    await visible(e.getByPlaceholder(/Jump to a channel/));
    await e.keyboard.type('back', { delay: 40 });
    await e.waitForTimeout(400);
    await shot(e, 'eve-quickswitcher-cross-server');
    const items = await switcherItems();
    note(who, `cross-server switcher "back": ${JSON.stringify(items)}`);
    await kb('Escape');
    if (!items.some((t) => /backend/.test(t))) throw new Error('channels of other servers are not in the quick switcher');
  });
  await task(who, 'Ctrl+K inside Work → "back" → Enter', async (c) => {
    await inWork();
    await kb('Control+K'); c.clicks++;
    await e.keyboard.type('back', { delay: 40 });
    await e.waitForTimeout(300);
    await shot(e, 'eve-quickswitcher');
    await kb('Enter');
    await e.waitForTimeout(600);
    const focus = await activeInfo();
    note(who, `after switcher jump focus=${focus}`);
    const hdr = await e.locator('body').innerText();
    if (!/Message #backend/.test(await composer(e).getAttribute('aria-label').catch(() => ''))) throw new Error('did not land in #backend');
    return `focus after jump: ${focus}`;
  });

  await task(who, 'Ctrl+K with no query (recent / unread list?) and server jump', async () => {
    await kb('Control+K');
    await e.waitForTimeout(400);
    await shot(e, 'eve-quickswitcher-empty');
    const items = await switcherItems();
    note(who, `switcher empty-query list: ${JSON.stringify(items)}`);
    await e.keyboard.type('*gam', { delay: 30 });
    await e.waitForTimeout(300);
    const items2 = await switcherItems();
    note(who, `switcher "*gam" (Discord's server prefix): ${JSON.stringify(items2)}`);
    await kb('Escape');
  });

  await task(who, 'Alt+↓ / Alt+↑ channel navigation', async () => {
    await inWork();
    await e.getByText('frontend').first().click();
    await e.waitForTimeout(400);
    const seq = [await url()];
    await composer(e).click();
    for (const k of ['Alt+ArrowDown', 'Alt+ArrowDown', 'Alt+ArrowUp']) { await kb(k); await e.waitForTimeout(350); seq.push(await url()); }
    note(who, `Alt-nav from composer: ${seq.join(' → ')}`);
    if (new Set(seq).size < 2) throw new Error('Alt+Arrow did nothing');
    return seq.length;
  });

  await task(who, 'Alt+Shift+↓ jumps to next unread channel', async () => {
    // friend posts in #deploys
    await f.getByText(srv1).first().click().catch(() => {});
    await f.getByText('deploys').first().click();
    const fb = composer(f); await fb.click(); await fb.fill(`deploy finished ${RUN}`); await fb.press('Enter');
    await e.getByText('frontend').first().click();
    await e.waitForTimeout(1200);
    await shot(e, 'eve-unread-before');
    await composer(e).click();
    await kb('Alt+Shift+ArrowDown');
    await e.waitForTimeout(700);
    const body = await e.locator('body').innerText();
    note(who, `after Alt+Shift+↓ url=${await url()}`);
    if (!body.includes(`deploy finished ${RUN}`)) throw new Error('did not jump to #deploys');
  });

  await task(who, 'markdown: code block, inline, bold, quote, spoiler, list, heading, masked link', async () => {
    const box = composer(e);
    await box.click();
    const md = [
      `md-test ${RUN} **bold** *ital* __under__ ~~strike~~ \`inline()\` ||spoiler||`,
      '```js',
      'const x = await fetch("/api"); // comment',
      'if (x.ok) { console.log(x) }',
      '```',
      '> quoted line',
      '- bullet one',
      '- bullet two',
      '# Heading',
      '[docs](https://example.com)'
    ];
    for (let i = 0; i < md.length; i += 1) {
      await e.keyboard.type(md[i]);
      if (i < md.length - 1) await kb('Shift+Enter');
    }
    await shot(e, 'eve-markdown-composing');
    await kb('Enter');
    const row = msgRow(e, `md-test ${RUN}`);
    await visible(row);
    await e.waitForTimeout(500);
    await row.first().scrollIntoViewIfNeeded();
    await shot(e, 'eve-markdown-rendered');
    const html = await row.first().innerHTML();
    const has = (re) => re.test(html);
    const r = {
      bold: has(/<strong/), ital: has(/<em/), under: has(/<u[ >]/), strike: has(/<(s|del)[ >]/), inline: has(/<code/),
      codeblock: has(/<pre/), highlighted: has(/hljs|token|language-js|text-\[#|shiki/), quote: has(/<blockquote/),
      list: has(/<ul|<li/), heading: has(/<h1|<h2|<h3/), link: has(/<a [^>]*href="https:\/\/example.com/), spoiler: has(/spoiler/i)
    };
    note(who, `markdown support: ${JSON.stringify(r)}`);
    const copyBtn = await row.first().locator('button[aria-label*="Copy"], button[title*="Copy"]').count();
    note(who, `code block copy button: ${copyBtn}`);
    return Object.entries(r).filter(([, v]) => !v).map(([k]) => k).join(',') || 'all rendered';
  });

  await task(who, 'slash commands: "/" menu, keyboard select /shrug', async () => {
    const box = composer(e);
    await box.click();
    await e.keyboard.type('/');
    await e.waitForTimeout(400);
    await shot(e, 'eve-slash-menu');
    const opts = (await e.locator('[role="option"]').allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, ' '));
    note(who, `slash menu shows ${opts.length} options: ${JSON.stringify(opts.slice(0, 6))}`);
    await e.keyboard.type('shr');
    await e.waitForTimeout(250);
    await kb('Tab');
    note(who, `composer after Tab-completing /shr: "${await composer(e).inputValue().catch(() => '?')}"`);
    await e.keyboard.type(`meh ${RUN}`);
    note(who, `composer before Enter: "${await composer(e).inputValue().catch(() => '?')}"`);
    await kb('Enter');
    await e.waitForTimeout(700);
    await shot(e, 'eve-slash-sent');
    const txt = await msgRow(e, `meh ${RUN}`).first().innerText().catch(() => '(no message)');
    note(who, `sent: ${txt.replace(/\s+/g, ' ').slice(-80)}`);
    const ok = /ツ/.test(txt);
    if (!ok) throw new Error('/shrug did not produce ¯\\_(ツ)_/¯');
  });

  await task(who, '↑ on empty composer edits last message; Enter saves; Esc cancels', async () => {
    const box = composer(e);
    await box.click();
    await box.fill('');
    await kb('ArrowUp');
    await e.waitForTimeout(300);
    const edit = e.locator('textarea[aria-label="Edit message"], [role="textbox"][aria-label="Edit message"]').first();
    await visible(edit, 3000);
    const focus = await activeInfo();
    await shot(e, 'eve-edit-inline');
    await kb('End');
    await e.keyboard.type(' (edited via keyboard)');
    await kb('Enter');
    await e.waitForTimeout(500);
    const saved = await msgRow(e, 'edited via keyboard').count();
    const back = await activeInfo();
    note(who, `edit focus=${focus}; after save focus=${back}`);
    // Esc cancel
    await composer(e).click();
    await kb('ArrowUp'); await e.waitForTimeout(200);
    await e.keyboard.type(' SHOULD NOT SAVE');
    await kb('Escape'); await e.waitForTimeout(300);
    const leaked = await msgRow(e, 'SHOULD NOT SAVE').count();
    if (!saved) throw new Error('edit did not save');
    if (leaked) throw new Error('Esc saved the edit');
  });

  await task(who, 'Ctrl+F opens message search?', async () => {
    await kb('Escape');
    await e.locator('body').click({ position: { x: 1000, y: 300 } }).catch(() => {});
    await kb('Control+F');
    await e.waitForTimeout(400);
    const sw = await e.getByPlaceholder(/Jump to a channel/).isVisible().catch(() => false);
    const focus = await activeInfo();
    await shot(e, 'eve-ctrl-f');
    note(who, `Ctrl+F → quickSwitcherOpen=${sw}, focus=${focus}`);
    await kb('Escape');
    if (sw) throw new Error('Ctrl+F (labelled "Search") opens the quick switcher, not message search');
  });
  await task(who, 'search operators via header box: from:, in:, has:, before:, mentions:', async (c) => {
    await inWork();
    const fb = composer(f);
    await f.getByText('backend').first().click();
    await fb.click(); await fb.fill(`needle backend ${RUN} https://example.org/x`); await fb.press('Enter');
    await f.getByText('frontend').first().click();
    await fb.click(); await fb.fill(`needle frontend ${RUN}`); await fb.press('Enter');
    await e.waitForTimeout(800);
    const box = e.getByLabel('Search messages').first();
    await box.click(); c.clicks++;
    await e.keyboard.type('from:');
    await e.waitForTimeout(500);
    await shot(e, 'eve-search-from-autocomplete');
    const sugg = (await e.locator('[role="option"], [role="listbox"] li').allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, ' ')).slice(0, 6);
    note(who, `after typing "from:" in header search, suggestions: ${JSON.stringify(sugg)}`);
    const queries = [`needle`, `from:finn_${RUN} needle`, 'in:backend needle', 'in:#backend needle', 'has:link needle', 'before:2020-01-01 needle', `after:2020-01-01 needle`, `mentions:eve_${RUN}`];
    const out = [];
    for (const q of queries) {
      await box.click();
      await box.fill(q);
      await box.press('Enter');
      await e.waitForTimeout(1100);
      const panel = await e.locator('body').innerText();
      const m = panel.match(/(\d+) results?/);
      out.push(`${q} → ${m ? m[1] : (/Nothing matched/.test(panel) ? '0' : '?')}`);
      if (q === 'has:link needle') await shot(e, 'eve-search-results');
    }
    note(who, `search: ${out.join(' | ')}`);
    return out.join(' | ');
  });

  await task(who, 'keyboard message navigation (focus a message, reply/react without mouse)', async () => {
    await kb('Escape');
    await composer(e).click();
    await kb('Shift+Tab'); await e.waitForTimeout(150);
    const f1 = await activeInfo();
    await kb('Shift+Tab'); await e.waitForTimeout(150);
    const f2 = await activeInfo();
    await kb('ArrowUp'); await e.waitForTimeout(150);
    const f3 = await activeInfo();
    const focusable = await e.locator('[id^="message-"][tabindex]').count();
    note(who, `Shift+Tab from composer: ${f1} → ${f2}; ArrowUp → ${f3}; messages with tabindex=${focusable}`);
    await shot(e, 'eve-message-focus');
    if (!focusable) throw new Error('messages are not keyboard-focusable');
  });

  await task(who, 'Ctrl+/ shortcut sheet', async () => {
    await composer(e).click();
    await kb('Control+Slash');
    await e.waitForTimeout(400);
    const dlg = e.getByRole('dialog', { name: /Keyboard shortcuts|shortcuts/i });
    await visible(dlg, 3000);
    await shot(e, 'eve-shortcuts');
    const txt = (await dlg.innerText()).replace(/\s+/g, ' ');
    note(who, `shortcut sheet: ${txt.slice(0, 900)}`);
    await kb('Escape');
  });

  await task(who, 'custom keybind: rebind quick switcher to Ctrl+J and use it', async (c) => {
    await kb('Control+Comma'); c.clicks++;
    await e.waitForTimeout(500);
    await e.getByRole('button', { name: /^Keybinds$/ }).or(e.getByRole('tab', { name: /Keybinds/ })).first().click(); c.clicks++;
    await e.waitForTimeout(400);
    await shot(e, 'eve-keybinds');
    const btn = e.getByRole('button', { name: 'Change the shortcut for Quick switcher' });
    await btn.click(); c.clicks++;
    await e.waitForTimeout(200);
    await kb('Control+J');
    await e.waitForTimeout(400);
    await shot(e, 'eve-keybinds-after');
    await kb('Escape'); await e.waitForTimeout(200); await kb('Escape');
    await e.waitForTimeout(300);
    await e.locator('body').click({ position: { x: 1000, y: 300 } }).catch(() => {});
    await kb('Control+J');
    await e.waitForTimeout(400);
    const opened = await e.getByPlaceholder(/Jump to a channel/).isVisible().catch(() => false);
    await kb('Escape');
    if (!opened) throw new Error('Ctrl+J did not open the switcher after rebinding');
  });

  await task(who, 'bulk: mark server read (Shift+Esc), multi-select messages to delete', async () => {
    await composer(e).click();
    await kb('Shift+Escape');
    await e.waitForTimeout(300);
    const row = e.locator('[id^="message-"]').last();
    await row.click({ button: 'right' });
    await e.waitForTimeout(300);
    const menu = (await e.locator('[role="menu"]').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    note(who, `message context menu: ${menu}`);
    await shot(e, 'eve-context-menu');
    await kb('Escape');
    if (!/select|bulk|purge/i.test(menu)) throw new Error('no multi-select / bulk delete in message menu');
  });

  note(who, `errors: ${e.errors.filter((x) => !/401|Unauthorized/.test(x)).slice(0, 4).join(' | ')}`);
  await E.context.close(); await F.context.close();
}

const browser = await chromium.launch({ executablePath: CHROMIUM });
try {
  if (which === 'sam' || which === 'all') await sam(browser);
  if (which === 'eve' || which === 'all') {
    await eve(browser);
  }
} finally {
  await browser.close();
  console.log('\n=== RESULTS ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}\t${r.who}\t${r.name}\t${r.s}s\t${r.clicks} clicks\t${r.extra ?? r.err ?? ''}`);
  console.log('\n=== NOTES ===\n' + notes.join('\n'));
}
