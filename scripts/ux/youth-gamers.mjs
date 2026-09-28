#!/usr/bin/env node
// ============================================================================
//  UX persona panel — "youth-gamers" (Ploy 14 / Jake 17 / Minh 21).
//
//  Expects the app already running on UX_PORT (default 7010), booted like
//  scripts/e2e/run.mjs does (SERVE_STATIC=1, throwaway DB_PATH/STORAGE_ROOT,
//  ALLOW_DEV_IDENTITY=0). Each task is timed, taps/clicks are counted, and a
//  screenshot is taken at every friction point into UX_SHOTS.
//
//  Usage: node scripts/ux/youth-gamers.mjs [--only=ploy,minh,jake]
// ============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import {
  BASE, CHROMIUM, SHOTS, DEVICES, newPersona, throttle, FAST3G, task, results, msgRow
} from './lib.mjs';

let AxeBuilder = null;
try { ({ default: AxeBuilder } = await import('@axe-core/playwright')); } catch { /* optional */ }

const RUN = crypto.randomBytes(3).toString('hex');
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const want = (who) => !only.length || only.includes(who);
const PW = { nok: 'nokpass2555', ploy: 'ploy2555!', minh: 'Minh@esports2026', jake: 'jakeGG_2026!', troll: 'trollpass123' };
const U = { nok: `nok_${RUN}`, ploy: `พลอย${RUN}`, minh: `minh_${RUN}`, jake: `jake_${RUN}`, troll: `xX_troll_${RUN}` };
const axeReport = [];

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing']
});

const text = async (page, n = 600) => (await page.locator('body').innerText().catch(() => '')).slice(0, n);
const smallTargets = (page, min = 44) => page.evaluate((m) => [...document.querySelectorAll('button, a[href], [role=button], [role=menuitem], input[type=checkbox], [role=switch]')]
  .filter((e) => e.offsetParent && getComputedStyle(e).visibility !== 'hidden')
  .map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), l: (e.getAttribute('aria-label') || e.title || e.innerText || '').trim().slice(0, 28) }; })
  .filter((x) => x.w > 0 && (x.w < m || x.h < m)), min);
async function axe(persona, label) {
  if (!AxeBuilder) return;
  try {
    const r = await new AxeBuilder({ page: persona.page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    axeReport.push({ who: persona.who, label, violations: r.violations.map((v) => `${v.id}(${v.impact}) x${v.nodes.length}`) });
  } catch (e) { axeReport.push({ who: persona.who, label, violations: ['axe failed: ' + e.message.slice(0, 80)] }); }
}

async function registerVia(persona, { user, pass, display, labels }) {
  const p = persona.page;
  await persona.click(p.getByRole('button', { name: labels.signUp }).last());
  await p.getByLabel(labels.username).fill(user);
  if (display) await p.getByLabel(labels.display).fill(display);
  await p.locator('input[type=password]').fill(pass);
  await persona.click(p.locator('form button[type=submit]'));
}
const EN = { signUp: /^Sign up$|^Register$/, username: /Username/, display: /Display name/ };
const TH = { signUp: /สมัครสมาชิก/, username: /ชื่อผู้ใช้/, display: /ชื่อที่แสดง/ };
const VI = { signUp: /Đăng ký/, username: /Tên đăng nhập/, display: /Tên hiển thị/ };

async function openServerMenu(persona) {
  const p = persona.page;
  await p.keyboard.press('Escape').catch(() => {});
  const btn = p.locator('button[aria-haspopup="menu"]').first();
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await persona.click(btn);
  await p.getByRole('menuitem').first().waitFor({ timeout: 4000 });
}
async function menuItem(persona, name) {
  await persona.click(persona.page.getByRole('menuitem', { name }).or(persona.page.getByRole('button', { name })));
}

// ---------------------------------------------------------------------------
//  0. Supporting cast: Nok (Ploy's classmate) + a troll account.
// ---------------------------------------------------------------------------
const nok = await newPersona(browser, 'nok', { ...DEVICES.pixel7, locale: 'th-TH' });
const troll = await newPersona(browser, 'troll', { ...DEVICES.desktop1080, locale: 'en-US' });
let classInvite = null;
const CLASS = `ม.2/5 ห้องเรา ${RUN.slice(0, 2)}`;
{
  const p = nok.page;
  await p.goto(BASE);
  await registerVia(nok, { user: U.nok, pass: PW.nok, labels: TH });
  await p.getByRole('navigation').first().waitFor();
  await p.goto(BASE + '/');
  await p.getByRole('button', { name: 'เพิ่มเซิร์ฟเวอร์' }).first().click();
  await p.getByRole('button', { name: /สร้างของฉันเอง|Create my own/ }).first().click();
  await p.locator('[role=dialog] input[type=text]').first().fill(CLASS);
  await p.locator('[role=dialog] button[type=submit]').first().click();
  await p.waitForFunction(() => /\/invite\//.test(document.getElementById('invite-link')?.value ?? ''), null, { timeout: 10000 });
  classInvite = await p.locator('#invite-link').inputValue();
  await p.keyboard.press('Escape');
  await p.locator('textarea').first().fill('ใครเล่น Roblox คืนนี้บ้าง 🎮 เข้า vc กัน');
  await p.locator('textarea').first().press('Enter');
  await p.waitForTimeout(400);
  // troll joins the class server too
  await troll.page.goto(classInvite);
  await registerVia(troll, { user: U.troll, pass: PW.troll, labels: EN });
  await troll.page.getByRole('button', { name: /Accept invite/ }).click();
  await troll.page.waitForTimeout(800);
  console.log('class invite', classInvite);
}

// ---------------------------------------------------------------------------
//  1. PLOY — 14, iPhone SE, Thai, Fast 3G + 4x CPU, never used Discord.
// ---------------------------------------------------------------------------
if (want('ploy')) {
  const ploy = await newPersona(browser, 'ploy', { ...DEVICES.iphoneSE, locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
  const p = ploy.page;
  const cdp = await throttle(p, { cpu: 4, net: FAST3G });

  await task(ploy, 'P1 open invite link from LINE (cold, Fast 3G)', async () => {
    const t0 = Date.now();
    await p.goto(classInvite, { waitUntil: 'commit' });
    await p.waitForTimeout(2500); await ploy.shot('invite-blank-2s');
    await p.locator('input, button').first().waitFor({ timeout: 30000 });
    const first = Date.now() - t0;
    await ploy.shot('invite-landing');
    const body = await text(p, 400);
    const seesServer = body.includes(CLASS);
    const seesWelcomeBack = /ยินดีต้อนรับกลับมา/.test(body);
    if (!seesServer) throw new Error(`first interactive screen after ${first}ms; server name not shown; greets new user with "${seesWelcomeBack ? 'ยินดีต้อนรับกลับมา! (Welcome back!)' : body.slice(0, 40)}"`);
    return `${first}ms to first screen`;
  });
  await axe(ploy, 'login (invite)');

  await task(ploy, 'P2 create account', async () => {
    await p.getByLabel(TH.username).waitFor();
    await ploy.click(p.getByText('สมัครสมาชิก', { exact: true }));
    await p.getByLabel(TH.username).fill('ploy');
    await p.locator('input[type=password]').fill('ploy');           // realistic: too short first
    await ploy.click(p.locator('form button[type=submit]'));
    await p.waitForTimeout(500);
    await ploy.shot('register-short-password');
    const nativeMsg = await p.locator('input[type=password]').evaluate((e) => e.validationMessage);
    await p.getByLabel(TH.username).fill(U.ploy);
    await p.locator('input[type=password]').fill(PW.ploy);
    await ploy.click(p.locator('form button[type=submit]'));
    await p.getByRole('button', { name: 'รับคำเชิญ' }).waitFor({ timeout: 20000 });
    await ploy.shot('invite-card-after-register');
    const fonts = await p.evaluate(() => [...document.querySelectorAll('input,textarea')].map((e) => getComputedStyle(e).fontSize));
    return `password error shown by browser in English: "${nativeMsg}"; no age/birthday asked`;
  });

  await task(ploy, 'P3 accept invite and find the class chat', async () => {
    await ploy.click(p.getByRole('button', { name: 'รับคำเชิญ' }));
    await p.waitForTimeout(2500);
    await ploy.shot('after-accept');
    const chatVisible = await p.evaluate(() => Boolean(document.elementFromPoint(320, 400)?.closest('[id^="message-"], [aria-busy]')));
    if (!chatVisible) {
      // she has to tap the channel in the drawer
      await ploy.click(p.getByText('general', { exact: true }));
      await p.waitForTimeout(1200);
    }
    await msgRow(p, 'Roblox').first().waitFor();
    await ploy.shot('class-chat');
    return chatVisible ? 'landed in chat' : 'drawer covered chat; had to tap "general" (English name) to see friend\'s message';
  });

  await task(ploy, 'P4 send a message', async () => {
    const box = p.locator('textarea').first();
    await ploy.click(box, { force: true });
    await box.fill('ไปๆ รอแปป 555');
    await box.press('Enter');
    await msgRow(p, 'รอแปป').first().waitFor();
    const fs_ = await box.evaluate((e) => getComputedStyle(e).fontSize);
    return `composer font-size ${fs_} (iOS auto-zooms inputs <16px)`;
  });

  await task(ploy, 'P5 react to friend (tap message → heart)', async () => {
    const row = msgRow(p, 'Roblox').first();
    const bb = await row.boundingBox();
    ploy.clicks += 1; await p.touchscreen.tap(bb.x + 180, bb.y + bb.height - 10);
    await p.waitForTimeout(400);
    await ploy.shot('tap-message-toolbar');
    const bar = row.locator('[role=toolbar] button');
    const sizes = await bar.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }));
    await ploy.click(bar.first());
    await row.getByRole('button', { name: /คุณ/ }).first().waitFor();
    await p.waitForTimeout(300);
    await ploy.shot('reacted');
    const stillOpen = await row.locator('[role=toolbar]').isVisible();
    return `toolbar buttons ${sizes.join(',')}; toolbar ${stillOpen ? 'stays stuck open after reacting' : 'closes'}`;
  });

  await task(ploy, 'P6 long-press message (LINE/TikTok habit)', async () => {
    const row = msgRow(p, 'Roblox').first();
    await p.touchscreen.tap(5, 300).catch(() => {}); // dismiss any toolbar
    await p.waitForTimeout(300);
    const bb = await row.boundingBox();
    const x = bb.x + 200; const y = bb.y + bb.height - 10;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await p.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(400);
    await ploy.shot('long-press');
    const open = await row.locator('[role=toolbar]').isVisible();
    const menu = await p.getByRole('menu').isVisible().catch(() => false);
    if (!open && !menu) throw new Error('long-press shows nothing (action bar opened on touchstart timer, then the trailing click toggled it shut)');
    return open ? 'action bar' : 'context menu';
  });

  await task(ploy, 'P7 send a photo', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
    ploy.clicks += 1; // tap (+)
    await p.locator('input[type=file]').first().setInputFiles({ name: 'IMG_0412.png', mimeType: 'image/png', buffer: png });
    await p.waitForTimeout(600);
    await ploy.shot('photo-staged');
    await ploy.click(p.getByRole('button', { name: 'ส่ง' }));
    await p.locator('[id^="message-"] img[alt*="IMG_0412"], [id^="message-"] img[src*="/api/"]').last().waitFor({ timeout: 20000 });
    await ploy.shot('photo-sent');
  });

  await task(ploy, 'P8 record a voice note', async () => {
    const mic = p.getByRole('button', { name: 'อัดข้อความเสียง' });
    await ploy.click(mic);
    await p.waitForTimeout(2200);
    await ploy.shot('voice-note-recording');
    const stop = p.getByRole('button', { name: /ส่ง|หยุด|Send|Stop/ }).last();
    await ploy.click(stop);
    await p.waitForTimeout(1500);
    await ploy.shot('voice-note-after');
    await p.locator('[id^="message-"] audio, [id^="message-"] button[aria-label="เล่น"]').first().waitFor({ timeout: 20000 }).catch(() => {});
    await ploy.shot('voice-note-sent');
    const audio = await p.locator('[id^="message-"] audio, [id^="message-"] button[aria-label="เล่น"]').count();
    if (!audio) throw new Error('no voice note appeared in chat');
  });

  await task(ploy, 'P9 mute the noisy class channel', async () => {
    const bell = p.getByRole('button', { name: /ตั้งค่าการแจ้งเตือน/ }).first();
    let path = 'bell';
    if (!(await bell.isVisible().catch(() => false))) {
      path = '⋮ overflow';
      await ploy.click(p.getByRole('button', { name: 'ตัวเลือกเพิ่มเติม' }));
      await p.waitForTimeout(400);
      await ploy.shot('overflow-menu');
      const items = await p.getByRole('menuitem').allInnerTexts();
      path += ` [${items.join(' | ')}]`;
      await ploy.click(p.getByRole('menuitem', { name: /แจ้งเตือน/ }));
    } else await ploy.click(bell);
    await p.waitForTimeout(400);
    await ploy.shot('notif-popover');
    await ploy.click(p.getByText('ปิดเสียงห้องนี้').first());
    await p.waitForTimeout(400);
    await ploy.shot('mute-durations');
    const dur = p.getByText(/จนกว่า|1 ชั่วโมง|8 ชั่วโมง/).first();
    if (await dur.isVisible().catch(() => false)) await ploy.click(dur);
    await p.waitForTimeout(400);
    await ploy.shot('muted');
    await p.keyboard.press('Escape').catch(() => {});
    return path;
  });

  await task(ploy, 'P10 block + report the troll who DMs her', async () => {
    // troll posts something nasty in the class channel
    const tp = troll.page;
    await tp.getByText('general', { exact: true }).first().click();
    await tp.locator('textarea').first().fill('ploy ur so ugly lol send pics');
    await tp.locator('textarea').first().press('Enter');
    await msgRow(p, 'ugly').first().waitFor({ timeout: 15000 });
    await ploy.shot('troll-message');
    const row = msgRow(p, 'ugly').first();
    const bb = await row.boundingBox();
    ploy.clicks += 1; await p.touchscreen.tap(bb.x + 200, bb.y + bb.height - 10);
    await p.waitForTimeout(300);
    await ploy.click(row.locator('[role=toolbar] button').last()); // "…"
    await p.waitForTimeout(400);
    await ploy.shot('more-menu');
    const items = await p.getByRole('menuitem').allInnerTexts();
    await ploy.click(p.getByRole('menuitem', { name: /รายงาน/ }));
    await p.waitForTimeout(400);
    await ploy.shot('report-dialog');
    const dlg = p.locator('[role=dialog], [role=alertdialog]').last();
    const opts = await dlg.locator('label, [role=radio], option').allInnerTexts().catch(() => []);
    await dlg.locator('input, textarea').first().fill('เขาขอรูปหนู กลัว').catch(() => {});
    await ploy.click(dlg.locator('label, [role=radio]').first()).catch(() => {});
    await ploy.click(dlg.getByRole('button', { name: /รายงาน|ส่ง/ }).last());
    await p.waitForTimeout(600);
    await ploy.shot('reported');
    // now block: tap avatar → profile → shield button
    await ploy.click(row.locator('img').first());
    await p.waitForTimeout(500);
    await ploy.shot('troll-profile');
    const blockBtn = p.getByRole('button', { name: /บล็อก/ });
    const hasLabelledBlock = await blockBtn.count();
    await ploy.click(p.locator('[role=dialog] button:has(svg)').last());
    await p.waitForTimeout(400);
    await ploy.shot('after-shield');
    const confirmBlock = p.locator('button', { hasText: /^บล็อก$/ }).last();
    if (await confirmBlock.isVisible().catch(() => false)) await ploy.click(confirmBlock);
    await p.waitForTimeout(600);
    await ploy.shot('blocked');
    await p.keyboard.press('Escape').catch(() => {});
    const close = p.locator('[role=dialog] button[aria-label="ปิด"]');
    if (await close.isVisible().catch(() => false)) await ploy.click(close);
    await p.waitForTimeout(400);
    await ploy.shot('chat-after-block');
    return `menu: ${items.slice(0, 12).join(' | ')}; report reasons: ${opts.slice(0, 6).join(' / ')}; block button labelled: ${hasLabelledBlock ? 'yes' : 'icon-only (shield)'}`;
  });

  await task(ploy, 'P11 switch to light theme + bigger text', async () => {
    await p.keyboard.press('Escape').catch(() => {});
    await p.waitForTimeout(300);
    const gear = p.getByRole('button', { name: 'ตั้งค่าผู้ใช้' });
    if (!(await gear.isVisible().catch(() => false))) await ploy.click(p.getByRole('button', { name: 'แสดงรายการห้อง' }));
    await p.waitForTimeout(500);
    await ploy.click(p.getByRole('button', { name: 'ตั้งค่าผู้ใช้' }));
    await p.waitForTimeout(700);
    await ploy.shot('user-settings');
    await ploy.click(p.getByRole('button', { name: /รูปลักษณ์|การแสดงผล/ }).first());
    await p.waitForTimeout(500);
    await ploy.shot('appearance');
    await ploy.click(p.getByText(/สว่าง/).first());
    await p.waitForTimeout(500);
    await ploy.shot('light-theme');
    const slider = p.locator('input[type=range]').first();
    if (await slider.count()) { await slider.focus(); for (let i = 0; i < 4; i += 1) await slider.press('ArrowRight'); }
    await p.waitForTimeout(300);
    await ploy.shot('bigger-text');
  });
  await p.keyboard.press('Escape').catch(() => {});
  await p.waitForTimeout(400);
  await ploy.shot('light-chat');
  ploy.small = await smallTargets(p);
  await axe(ploy, 'chat (light)');
  globalThis.ploy = ploy;
}

// ---------------------------------------------------------------------------
//  2. MINH — 21, Vietnamese, 1366x768 laptop, sets up an esports club server.
// ---------------------------------------------------------------------------
let clubInvite = null;
const CLUB = `UEH Esports ${RUN.slice(0, 2)}`;
if (want('minh') || want('jake')) {
  const minh = await newPersona(browser, 'minh', { ...DEVICES.laptop768, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
  const p = minh.page;
  const dlg = () => p.locator('[role=dialog]').last();
  await p.goto(BASE);

  await task(minh, 'M1 register (Vietnamese auto-detected)', async () => {
    await registerVia(minh, { user: U.minh, pass: PW.minh, display: 'Minh (UEH Esports)', labels: VI });
    await p.getByRole('navigation').first().waitFor();
    await minh.shot('home');
  });

  await task(minh, 'M2 create club server (look for a "club" template)', async () => {
    await minh.click(p.getByRole('button', { name: 'Thêm máy chủ' }));
    await minh.click(p.getByRole('button', { name: /Bắt đầu từ mẫu/ }));
    await p.waitForTimeout(300);
    await minh.shot('template-needs-code');
    const needsCode = await dlg().locator('input').count();
    await p.keyboard.press('Escape');
    await minh.click(p.getByRole('button', { name: 'Thêm máy chủ' }));
    await minh.click(p.getByRole('button', { name: /Tự tạo/ }));
    await dlg().locator('input:not([type]), input[type=text]').first().fill(CLUB);
    await minh.click(dlg().locator('button[type=submit]'));
    await p.waitForFunction(() => /\/invite\//.test(document.getElementById('invite-link')?.value ?? ''), null, { timeout: 10000 });
    clubInvite = await p.locator('#invite-link').inputValue();
    await minh.shot('invite-offer');
    await p.keyboard.press('Escape');
    const cats = await p.getByText(/TEXT CHANNELS|VOICE CHANNELS/).count();
    return `"template" = paste-a-code only${needsCode ? '' : '?'}; default categories in English: ${cats}`;
  });

  await task(minh, 'M3 create categories + channels (announcements, rules, Valorant/LMHT voice)', async () => {
    await openServerMenu(minh, CLUB);
    await p.waitForTimeout(300);
    await minh.shot('server-menu');
    const hasCategory = await p.getByRole('menuitem', { name: /danh mục/i }).count();
    await menuItem(minh, 'Tạo kênh');
    await minh.click(dlg().getByText('Thông báo', { exact: true }));
    await dlg().locator('input:not([type]), input[type=text]').first().fill('thông báo');
    await minh.shot('create-channel-fold');
    const nameBox = await dlg().locator('input:not([type]), input[type=text]').first().boundingBox();
    await minh.click(dlg().getByRole('button', { name: 'Tạo kênh' }));
    await p.waitForTimeout(700);
    await openServerMenu(minh, CLUB);
    await menuItem(minh, 'Tạo kênh thoại');
    await dlg().locator('input:not([type]), input[type=text]').first().fill('Valorant 5v5');
    await minh.click(dlg().getByRole('button', { name: 'Tạo kênh' }));
    await p.waitForTimeout(700);
    await minh.shot('channels');
    if (!hasCategory) throw new Error(`no "Create category" anywhere; channel name field at y=${Math.round(nameBox?.y ?? -1)} (viewport 768) under 6 type cards`);
  });

  await task(minh, 'M4 create roles (Ban chủ nhiệm / Thành viên / Tân binh) with colours', async () => {
    await openServerMenu(minh, CLUB);
    await menuItem(minh, 'Cài đặt máy chủ');
    await minh.click(dlg().getByRole('button', { name: /^Vai trò$/ }));
    let blocked = 0;
    for (const [name, i] of [['Ban chủ nhiệm', 5], ['Thành viên', 2], ['Tân binh', 3]]) {
      await minh.click(dlg().getByRole('button', { name: /Tạo vai trò/ }));
      await p.waitForTimeout(500);
      if (await dlg().getByText(/thay đổi chưa lưu/).isVisible().catch(() => false)) {
        blocked += 1;
        await minh.shot('unsaved-changes-block');
        await minh.click(dlg().getByRole('button', { name: /Lưu thay đổi/ }));
        await p.waitForTimeout(600);
        await minh.click(dlg().getByRole('button', { name: /Tạo vai trò/ }));
        await p.waitForTimeout(500);
      }
      const nameInput = dlg().locator('input:not([type]), input[type=text]').first();
      await nameInput.fill(name);
      await minh.click(dlg().locator('button[aria-label^="Màu"], button[aria-label^="Colour"]').nth(i));
      await p.waitForTimeout(300);
    }
    await minh.click(dlg().getByRole('button', { name: /Lưu thay đổi/ }));
    await p.waitForTimeout(600);
    await minh.shot('roles');
    const delLabel = await dlg().getByRole('button', { name: /xóa vai trò/i }).first().innerText().catch(() => '');
    const saveBar = await dlg().getByRole('button', { name: /Lưu/ }).count();
    const hex = await dlg().locator('input[type=color], input[placeholder^="#"]').count();
    return `blocked by unsaved-changes bar ${blocked}x; delete button reads "${delLabel.trim()}" (= "role deleted"); custom hex colour input: ${hex ? 'yes' : 'no'}; save bar: ${saveBar ? 'yes' : 'auto-save'}`;
  });

  await task(minh, 'M5 onboarding: rules + "which game do you play?" question', async () => {
    await minh.click(dlg().getByRole('button', { name: /Chào đón thành viên/ }));
    await p.waitForTimeout(600);
    await minh.shot('onboarding-tab');
    await minh.click(dlg().getByText('Yêu cầu thành viên mới chấp nhận quy tắc'));
    await minh.click(dlg().getByRole('button', { name: /Thêm quy tắc/ }));
    await dlg().locator('textarea').first().fill('Tôn trọng mọi người, không toxic');
    await minh.shot('onboarding-unsaved-bar-overlaps');
    await minh.click(dlg().getByRole('button', { name: /Thêm câu hỏi/ }));
    await p.waitForTimeout(300);
    await minh.shot('onboarding-question-blank');
    await minh.click(dlg().getByRole('button', { name: /Lưu thay đổi/ }));   // realistic: saves before filling the title
    await p.waitForTimeout(700);
    await minh.shot('onboarding-error-toast');
    const toast = await p.locator('[role=status], [role=alert]').allInnerTexts().catch(() => []);
    await dlg().getByPlaceholder(/Điều gì đưa bạn/).fill('Bạn chơi game nào?');
    await dlg().getByPlaceholder(/Tiêu đề lựa chọn/).first().fill('Valorant');
    await minh.click(dlg().getByRole('button', { name: '@Tân binh' }).or(dlg().getByText('@Tân binh')));
    await minh.shot('onboarding-filled');
    const save = dlg().getByRole('button', { name: /Lưu thay đổi/ });
    if (await save.count()) await minh.click(save);
    await p.waitForTimeout(600);
    await minh.shot('onboarding-saved');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    return `error on incomplete question: ${toast.join(' / ').slice(0, 120)}`;
  });

  const closeAll = async () => {
    for (let i = 0; i < 4 && await p.locator('[role=dialog]').count(); i += 1) {
      const save = p.getByRole('button', { name: /Lưu thay đổi/ });
      if (await save.isVisible().catch(() => false)) await save.click();
      await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    }
  };
  await task(minh, 'M6 schedule an event (Valorant scrim, Sat 19:00)', async () => {
    await closeAll();
    await openServerMenu(minh, CLUB);
    await menuItem(minh, 'Sự kiện');
    await p.waitForTimeout(500);
    await minh.click(p.getByRole('button', { name: /Tạo sự kiện/ }));
    await p.waitForTimeout(400);
    const d = dlg();
    await d.locator('input:not([type]), input[type=text]').first().fill('Scrim Valorant nội bộ');
    const defaultWhere = await d.locator('[aria-pressed=true], [aria-checked=true]').first().innerText().catch(() => '?');
    await minh.click(d.getByRole('button', { name: /Kênh thoại/ }).or(d.getByRole('radio', { name: /Kênh thoại/ })));
    await minh.shot('event-form');
    const dt = d.locator('input[type=datetime-local]').first();
    const when = new Date(Date.now() + 3 * 864e5); when.setHours(19, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    await dt.fill(`${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T19:00`);
    await minh.click(d.getByRole('button', { name: /^Tạo|Lên lịch/ }).last());
    await p.waitForTimeout(700);
    await minh.shot('event-created');
    await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
    return `default "where": ${defaultWhere}`;
  });

  await task(minh, 'M7 post a poll (which night for training?)', async () => {
    await closeAll();
    await p.getByText('general', { exact: true }).first().click();
    await minh.click(p.getByRole('button', { name: /Tạo cuộc thăm dò|thăm dò/i }).first());
    await p.waitForTimeout(400);
    const d = dlg();
    const ins = d.locator('input:not([type]), input[type=text]');
    await ins.nth(0).fill('Tập luyện tối nào?');
    await ins.nth(1).fill('Thứ 3');
    await ins.nth(2).fill('Thứ 5');
    await minh.shot('poll-form');
    await minh.click(d.getByRole('button', { name: /Đăng|Tạo|Gửi/ }).last());
    await p.waitForTimeout(700);
    await minh.shot('poll-posted');
  });
  await axe(minh, 'server with poll');
  minh.small = await smallTargets(p, 24);
  globalThis.minh = minh;
}

// ---------------------------------------------------------------------------
//  3. JAKE — 17, Discord power user, 1920x1080 Windows + Android.
// ---------------------------------------------------------------------------
if (want('jake') && clubInvite) {
  const jake = await newPersona(browser, 'jake', { ...DEVICES.desktop1080, locale: 'en-US', timezoneId: 'America/Chicago' });
  const p = jake.page;
  await task(jake, 'J1 open club invite, sign up, pass onboarding', async () => {
    await p.goto(clubInvite);
    await p.getByLabel(EN.username).waitFor();
    await jake.shot('invite-login');
    await registerVia(jake, { user: U.jake, pass: PW.jake, labels: EN });
    await jake.click(p.getByRole('button', { name: /Accept invite/ }));
    await p.waitForTimeout(1500);
    await jake.shot('after-join');
    const onboarding = await p.getByRole('dialog').count();
    let steps = 0;
    while (steps < 5 && await p.getByRole('dialog').count()) {
      steps += 1;
      const d = p.getByRole('dialog').last();
      await jake.shot('onboarding-step' + steps);
      const lab = d.locator('label').filter({ hasText: /I have read|Valorant/ });
      if (await lab.count()) await jake.click(lab.first());
      await jake.click(d.getByRole('button', { name: /Next|Continue|Finish|Tiếp|Hoàn tất/ }).last());
      await p.waitForTimeout(700);
    }
    await jake.shot('after-onboarding');
    const roles = await p.evaluate(async () => (await (await fetch('/api/auth/me')).json()).id).catch(() => null);
    return onboarding ? `onboarding ${steps} steps` : 'no onboarding/rules gate shown';
  });

  await task(jake, 'J2 markdown + code block + spoiler + emoji shortcode', async () => {
    await p.getByText('general', { exact: true }).first().click();
    const box = p.locator('textarea').first();
    await box.fill('**gg** _ez_ ||clutch 1v4|| `aim` :fire:');
    await p.waitForTimeout(300);
    await jake.shot('emoji-autocomplete');
    await box.press('Enter');
    await box.press('Enter').catch(() => {});
    await p.keyboard.type('```js');
    await p.keyboard.press('Shift+Enter');
    await p.keyboard.type('const kd = 3.2');
    await p.keyboard.press('Shift+Enter');
    await p.keyboard.type('```');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(700);
    await jake.shot('markdown');
    const bold = await p.locator('[id^="message-"] strong').count();
    const spoiler = await p.locator('[id^="message-"] [class*="spoiler"], [id^="message-"] [aria-label*="poiler"]').count();
    const code = await p.locator('[id^="message-"] pre').count();
    return `bold:${bold} spoiler:${spoiler} codeblock:${code}`;
  });

  await task(jake, 'J3 keybinds: Up=edit last, Ctrl+K switcher, Ctrl+/ shortcuts, Esc', async () => {
    const box = p.locator('textarea').first();
    await box.click();
    await box.press('ArrowUp');
    await p.waitForTimeout(300);
    const editing = await p.locator('textarea[aria-label="Edit message"]').count();
    await p.keyboard.press('Escape');
    await p.keyboard.press('Control+k');
    await p.waitForTimeout(300);
    await jake.shot('quick-switcher');
    const qs = await p.getByRole('dialog').count();
    await p.keyboard.type('valo');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(500);
    await p.keyboard.press('Control+/');
    await p.waitForTimeout(400);
    await jake.shot('shortcuts');
    const sc = await p.getByRole('dialog').count();
    await p.keyboard.press('Escape');
    return `edit-last:${editing ? 'yes' : 'no'} quickswitcher:${qs ? 'yes' : 'no'} shortcuts:${sc ? 'yes' : 'no'}`;
  });

  await task(jake, 'J4 join voice, set push-to-talk, share screen', async () => {
    await p.getByText('Valorant 5v5').first().click();
    await p.waitForTimeout(800);
    await jake.shot('voice-channel');
    const join = p.getByRole('button', { name: 'Join Voice', exact: true }).first();
    const autoJoined = await p.getByText('Voice connected').isVisible().catch(() => false);
    if (!autoJoined && await join.isVisible().catch(() => false)) await jake.click(join);
    await p.waitForTimeout(2500);
    await jake.shot('in-voice');
    const share = p.getByTitle('Share screen').first();
    let shared = 'no button';
    if (await share.count()) { await jake.click(share); await p.waitForTimeout(2500); shared = 'clicked'; await jake.shot('screen-share'); }
    await jake.click(p.getByRole('button', { name: 'User settings' }));
    await jake.click(p.getByRole('dialog').getByRole('button', { name: /Voice/ }).first());
    await p.waitForTimeout(500);
    await jake.shot('voice-settings');
    await jake.click(p.getByRole('dialog').getByText('Push to talk', { exact: true }));
    await p.waitForTimeout(400);
    await p.getByRole('dialog').getByText('Push to talk', { exact: true }).scrollIntoViewIfNeeded();
    await jake.shot('ptt');
    const pttText = await p.getByRole('dialog').innerText();
    const keybind = /Shortcut|Keybind|Record|Press a key|`|Backquote/i.test(pttText.slice(pttText.indexOf('Push to talk')));
    await p.keyboard.press('Escape');
    return `auto-joined on click: ${autoJoined}; screen share: ${shared}; PTT key field visible: ${keybind}`;
  });

  await task(jake, 'J5 sticker / GIF / custom emoji / Nitro-ish flair', async () => {
    await p.getByText('general', { exact: true }).first().click();
    const gif = await p.getByRole('button', { name: /GIF/ }).count();
    const sticker = await p.getByRole('button', { name: /Sticker/ }).count();
    await jake.click(p.getByRole('button', { name: /^Emoji$/ }).first());
    await p.waitForTimeout(500);
    await jake.shot('emoji-picker');
    await p.keyboard.press('Escape');
    return `GIF button:${gif} sticker button:${sticker}`;
  });

  await task(jake, 'J6 profile customisation (banner, about me, status)', async () => {
    await jake.click(p.getByRole('button', { name: 'User settings' }));
    await jake.click(p.getByRole('dialog').getByRole('button', { name: /Profile/ }).first());
    await p.waitForTimeout(500);
    await jake.shot('profile-settings');
    const t = await text(p, 3000);
    await p.keyboard.press('Escape');
    return ['Banner', 'About', 'Pronouns', 'colour', 'color', 'Effect', 'Decoration'].filter((w) => t.includes(w)).join(',');
  });
  await axe(jake, 'chat desktop');

  // Jake on Android
  const jm = await newPersona(browser, 'jake-android', { ...DEVICES.pixel7, locale: 'en-US' });
  await task(jm, 'J7 same account on Pixel 7: reply + voice join', async () => {
    const q = jm.page;
    await q.goto(BASE);
    await q.getByLabel(EN.username).fill(U.jake);
    await q.locator('input[type=password]').fill(PW.jake);
    await q.locator('form button[type=submit]').click();
    await q.getByRole('navigation').first().waitFor();
    await q.waitForTimeout(1200);
    await jm.shot('android-home');
    jm.small = await smallTargets(q);
  });
  globalThis.jake = jake; globalThis.jm = jm;
}

// ---------------------------------------------------------------------------
console.log('\n=== RESULTS ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}\t${r.who}\t${r.name}\t${r.s}s\t${r.clicks}\t${r.note}`);
console.log('\n=== AXE ===');
for (const a of axeReport) console.log(a.who, a.label, a.violations.join(', '));
for (const w of ['ploy', 'minh', 'jm']) if (globalThis[w]?.small) console.log(`\nsmall targets ${w}:`, globalThis[w].small.length, JSON.stringify(globalThis[w].small.slice(0, 25)));
for (const w of ['ploy', 'minh', 'jake']) if (globalThis[w]?.errors?.length) console.log(`errors ${w}:`, globalThis[w].errors.slice(0, 5));
fs.writeFileSync(path.join(SHOTS, 'persona-youth-gamers-results.json'), JSON.stringify({ results, axeReport }, null, 2));
await browser.close();
