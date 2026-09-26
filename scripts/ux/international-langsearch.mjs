#!/usr/bin/env node
// "Where do I change the language?" — each persona types the word for
// "language" into the User settings search, in their own language.
import { chromium } from 'playwright-core';
import { PERSONAS, makeUser, register } from './international.mjs';

const WORD = { dmitri: 'язык', yuki: '言語', jiwoo: '언어', hans: 'Sprache', wei: '語言', olga: 'język' };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-proxy-server'] });
for (const key of Object.keys(WORD)) {
  PERSONAS[key].user += 'l';
  const u = await makeUser(browser, key);
  try {
    await register(u);
    if (u.p.mobile) await u.page.getByRole('button', { name: u.t('sidebar.openChannels') }).first().click().catch(() => {});
    await u.page.getByRole('button', { name: u.t('sidebar.userSettings') }).first().click();
    await u.page.waitForTimeout(500);
    await u.page.getByPlaceholder(u.t('settings.searchPlaceholder')).fill(WORD[key]);
    await u.page.waitForTimeout(500);
    await u.shot('settings-search-language');
    const nav = await u.page.getByRole('navigation', { name: u.t('settings.userSettings') }).innerText().catch(() => '?');
    console.log(key, WORD[key], '→', JSON.stringify(nav.replace(/\n+/g, ' | ')));
  } catch (e) { console.log(key, 'ERR', e.message.split('\n')[0]); }
  await u.ctx.close();
}
await browser.close();
