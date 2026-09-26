#!/usr/bin/env node
// Each persona creates their *own* community server (named in their language)
// and walks every Server settings page, so long German/Polish labels and CJK
// layouts are audited on owner-only screens too.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PERSONAS, makeUser, register, tabs, SERVER_TABS } from './international.mjs';

const SHOTS = process.env.UX_SHOTS
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';
const NAMES = {
  hans: 'Amateurfunkclub Ortsverband Süd-Württemberg e. V.',
  olga: 'Koło Gospodyń Wiejskich — Źródła',
  wei: '台北夜市美食研究社',
  yuki: '経理部チーム（東京本社）',
  jiwoo: '컴퓨터공학과 24학번 스터디'
};
const only = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-proxy-server'] });
const out = {};
for (const key of (only.length ? only : Object.keys(NAMES))) {
  PERSONAS[key].user += 'o';
  const u = await makeUser(browser, key);
  const pg = u.page;
  try {
    await register(u);
    if (u.p.mobile) await pg.getByRole('button', { name: u.t('sidebar.openChannels') }).first().click().catch(() => {});
    await pg.getByRole('button', { name: u.t('server.addServer') }).first().click();
    await pg.getByRole('button', { name: new RegExp(u.t('server.createOwn')) }).click();
    await pg.getByPlaceholder(u.t('server.namePlaceholder')).fill(NAMES[key]);
    await u.shot('owner-create-form'); await u.audit('owner-create');
    await pg.getByRole('button', { name: new RegExp('^' + u.t('common.create') + '$') }).last().click();
    await pg.waitForTimeout(1500);
    await u.shot('owner-invite-offer'); await u.audit('owner-invite-offer');
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(400);
    if (u.p.mobile) await pg.getByRole('button', { name: u.t('sidebar.openChannels') }).first().click().catch(() => {});
    await pg.getByText(NAMES[key]).first().click();
    await pg.waitForTimeout(400);
    await u.shot('owner-server-dropdown'); await u.audit('owner-dropdown'); await u.englishLeft('owner-dropdown');
    await pg.getByRole('menuitem', { name: u.t('server.settings') }).first().click();
    await pg.waitForTimeout(600);
    await u.shot('owner-server-settings'); await u.audit('owner-server-settings');
    await tabs(u, 'server', SERVER_TABS, 'owner-ss');
  } catch (e) { u.note('ERR ' + e.message.split('\n')[0]); await u.shot('owner-FAIL'); }
  out[key] = {
    overflow: [...new Set(u.log.overflow.map((o) => `${o.kind} "${o.text}" ${o.w}/${o.sw} @${o.where}`))],
    english: [...new Set(u.log.english.map((e) => `${e.key} = "${e.text}" @${e.where}`))],
    notes: u.log.notes
  };
  await u.ctx.close();
}
fs.writeFileSync(path.join(SHOTS, 'persona-international-owner.json'), JSON.stringify(out, null, 2));
for (const [k, v] of Object.entries(out)) {
  console.log('=== ' + k);
  for (const x of v.overflow) if (!/Mozilla|dmitri|Müller \(DL|Wiśniewska$/.test(x)) console.log('  OV ' + x);
  for (const x of v.english) console.log('  EN ' + x);
  for (const x of v.notes) console.log('  NOTE ' + x);
}
await browser.close();
