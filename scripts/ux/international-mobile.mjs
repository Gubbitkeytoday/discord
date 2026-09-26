#!/usr/bin/env node
// Phone-only follow-up for the "international" persona run: Yuki (ja), Ji-woo (ko)
// and Somchai (th) on phones open search, long-press a message, and walk
// User settings through the drawer. Needs an invite URL from international.mjs
// (UX_INVITE=http://…/invite/CODE).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PERSONAS, makeUser, register } from './international.mjs';

const INVITE = process.env.UX_INVITE;
const SHOTS = process.env.UX_SHOTS
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-proxy-server'] });
const out = {};
for (const key of ['yuki', 'jiwoo', 'somchai']) {
  PERSONAS[key].user += process.env.UX_SUFFIX || 'm';
  const u = await makeUser(browser, key);
  const pg = u.page;
  const log = (out[key] = []);
  const tryStep = async (name, fn) => {
    const t0 = Date.now();
    try { await fn(); log.push({ name, ok: true, ms: Date.now() - t0 }); }
    catch (e) { log.push({ name, ok: false, err: String(e.message).split('\n')[0].slice(0, 160) }); await u.shot('m-FAIL-' + name); }
  };
  await tryStep('register', () => register(u));
  await tryStep('join', async () => {
    await pg.goto(INVITE); await pg.waitForTimeout(1000);
    await pg.getByRole('button', { name: new RegExp(u.t('invites.acceptInvite')) }).first().click();
    await pg.waitForTimeout(1200);
    await pg.getByText('general', { exact: true }).first().click();
    await pg.waitForTimeout(600);
  });
  await tryStep('search', async () => {
    await pg.getByRole('button', { name: u.t('chat.searchMessages') }).first().click();
    await pg.waitForTimeout(400);
    await u.shot('m-search-open');
    await pg.keyboard.type(u.p.search); await pg.keyboard.press('Enter');
    await pg.waitForTimeout(1500);
    await u.shot('m-search-results'); await u.audit('m-search'); await u.englishLeft('m-search');
    const txt = await pg.locator('body').innerText();
    log.push({ name: `search hits for ${u.p.search}`, value: txt.split(u.p.search).length - 1 });
    await pg.mouse.click(28, 30); // back arrow (top-left)
    await pg.waitForTimeout(400);
  });
  await tryStep('long-press message', async () => {
    const row = pg.locator('[id^="message-"]').last();
    const box = await row.boundingBox();
    await pg.touchscreen.tap(box.x + 60, box.y + 20).catch(() => {});
    await pg.mouse.move(box.x + 60, box.y + 20); await pg.mouse.down(); await pg.waitForTimeout(700); await pg.mouse.up();
    await pg.waitForTimeout(500);
    await u.shot('m-long-press'); await u.audit('m-long-press'); await u.englishLeft('m-long-press');
    await pg.keyboard.press('Escape');
  });
  await tryStep('settings via drawer', async () => {
    await pg.getByRole('button', { name: u.t('sidebar.openChannels') }).first().click();
    await pg.waitForTimeout(500);
    await pg.getByRole('button', { name: u.t('sidebar.userSettings') }).first().click();
    await pg.waitForTimeout(700);
    await u.shot('m-settings-home'); await u.audit('m-settings'); await u.englishLeft('m-settings');
    for (const k of ['settings.appearanceTab', 'settings.notificationsTab', 'settings.accountTab', 'settings.accessibilityTab']) {
      const b = pg.getByRole('button', { name: u.t(k), exact: true }).first();
      if (!(await b.isVisible().catch(() => false))) { log.push({ name: 'tab not visible ' + k }); continue; }
      await b.click(); await pg.waitForTimeout(500);
      await u.shot('m-' + k); await u.audit('m-' + k); await u.englishLeft('m-' + k);
      await pg.screenshot({ path: path.join(SHOTS, `persona-international-${key}-m-${k}-full.png`), fullPage: true }).catch(() => {});
      const back = pg.getByRole('button', { name: new RegExp(u.t('common.back'), 'i') }).first();
      if (await back.isVisible().catch(() => false)) await back.click();
      await pg.waitForTimeout(300);
    }
  });
  log.push({ overflow: u.log.overflow.map((o) => `${o.where}: ${o.kind} ${o.text} ${o.w}/${o.sw}`), english: u.log.english.map((e) => `${e.where}: ${e.key}=${e.text}`) });
}
fs.writeFileSync(path.join(SHOTS, 'persona-international-mobile.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
await browser.close();
