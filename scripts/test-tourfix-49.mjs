#!/usr/bin/env node
// ============================================================================
//  Regressions from the full screenshot tour (round 49).
//
//   1/6  Previews (inbox, reply spines, search, forum cards) show names and
//        words, never `<@user-me>` or `**voice**` — src/utils/plainText.js.
//   2    Spoiler covers stand out from the chat surface in every theme.
//   4    Unreads can cover every server: read states carry other servers'
//        channels, and each server's channel list is fetchable by a member.
//   5    Every audit action the server writes has a translated label, and
//        change details never show a storage path, URL or JSON.
//   7    The quick switcher lists the channel you are in.
//   12   Count strings with a noun use plural forms.
//   16   /discover and unknown paths are routed (not a silent Home).
//   24   Thai: the ESC hint and Webhooks are localised.
//   25   Screen-reader announcements join without doubled periods.
//  Runs against SQLite and PostgreSQL (npm run test:pg).
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, stopServer, BASE } from './testHarness.mjs';
import { markdownToPlain, joinSentences } from '../src/utils/plainText.js';
import { AUDIT_ACTION_KEYS, auditActionLabel, formatAuditChange } from '../src/utils/auditFormat.js';
import { rankSwitcherEntries } from '../src/utils/switcherRank.js';
import en from '../src/i18n/en.js';
import th from '../src/i18n/th.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const t = (key, vars = {}) => String(en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? `{${name}}`);

before(startServer);
after(stopServer);

const as = (userId) => ({ 'x-user-id': userId });
async function api(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

// --- 1 / 6: plain-text previews -------------------------------------------------

describe('markdownToPlain', () => {
  const names = {
    resolveUser: (id) => ({ 'user-me': 'Alex', 'user-2': 'Kira' })[id] ?? null,
    resolveChannel: (id) => ({ 'chan-102': 'general-chat' })[id] ?? null,
    resolveRole: (id) => ({ 'role-1-mod': { name: 'Moderator' } })[id] ?? null
  };

  test('mentions become names (the inbox showed <@user-me>)', () => {
    assert.equal(markdownToPlain('GG everyone! <@user-me> you carried 🏆', names), 'GG everyone! @Alex you carried 🏆');
    assert.equal(markdownToPlain('<@!user-2> see <#chan-102>, <@&role-1-mod>', names), '@Kira see #general-chat, @Moderator');
    assert.equal(markdownToPlain('hi <@1553000000000000000>', { unknownUser: 'Unknown user' }), 'hi @Unknown user');
    assert.doesNotMatch(markdownToPlain('<@user-me> <#chan-9> <@&r>', {}), /[<>]/);
  });

  test('markup is removed, words are kept (reply previews showed **voice**)', () => {
    assert.equal(markdownToPlain('Just pushed the new **voice** reconnect logic'), 'Just pushed the new voice reconnect logic');
    assert.equal(markdownToPlain('***both*** __under__ ~~gone~~ *it* _em_ `code`'), 'both under gone it em code');
    assert.equal(markdownToPlain('# Title\n> quoted\n- item\n-# small'), 'Title quoted • item small');
    assert.equal(markdownToPlain('see [the docs](https://example.com/docs)'), 'see the docs');
    assert.equal(markdownToPlain('```js\nawait deploy();\n```'), 'await deploy();');
    assert.equal(markdownToPlain('<:partyblob:123456> and <a:dance:42>'), ':partyblob: and :dance:');
  });

  test('arithmetic, snake_case and escapes survive', () => {
    assert.equal(markdownToPlain('2 * 3 * 4 = 24'), '2 * 3 * 4 = 24');
    assert.equal(markdownToPlain('use snake_case_names'), 'use snake_case_names');
    assert.equal(markdownToPlain('\\*not italic\\*'), '*not italic*');
  });

  test('spoilers never leak into a preview', () => {
    const out = markdownToPlain('the killer is ||the butler||', { spoiler: '[SPOILER]' });
    assert.equal(out, 'the killer is [SPOILER]');
    assert.doesNotMatch(out, /butler/);
  });

  test('line breaks are kept on request', () => {
    assert.equal(markdownToPlain('a\n**b**', { singleLine: false }), 'a\nb');
    assert.equal(markdownToPlain(null), '');
  });

  test('every preview surface goes through the summariser', () => {
    for (const file of [
      'src/components/NotificationsInbox.jsx', 'src/components/SearchResultsPanel.jsx', 'src/components/ForumView.jsx',
      'src/components/admin/MessageRequests.jsx', 'src/components/ForwardMessageModal.jsx', 'src/components/ChatArea.jsx'
    ]) assert.match(read(file), /markdownToPlain\(/, file);
    assert.match(read('src/components/chat/MessageRow.jsx'), /ctx\.previewText\(msg\.replyToMsg\.content\)/);
    assert.match(read('src/components/PinnedMessagesPopover.jsx'), /renderText\(msg\.content\)/);
  });
});

// --- 2: spoiler cover contrast ----------------------------------------------------

describe('spoiler cover', () => {
  const css = read('src/index.css');
  const block = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, selector);
    const body = css.slice(start, css.indexOf('\n}', start));
    const out = {};
    for (const [, name, value] of body.matchAll(/--base-([\w-]+):\s*([^;]+);/g)) {
      const hex = /#[0-9a-fA-F]{6}\b/.exec(value)?.[0];
      if (hex) out[name] = hex;
    }
    return out;
  };
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  test('the renderer uses theme tokens, not a surface colour', () => {
    const parser = read('src/utils/markdownParser.jsx');
    assert.match(parser, /bg-d-spoiler text-transparent/);
    assert.doesNotMatch(parser, /bg-d-sunken text-transparent/);
  });

  test('the cover reaches 3:1 against the chat in dark, light, ash and onyx', () => {
    const share = Number(/--color-d-spoiler:\s*color-mix\(in srgb, var\(--color-text-default\) (\d+)%, var\(--color-bg-chat\)\)/.exec(css)?.[1]);
    assert.ok(share > 0, 'spoiler token is a text/chat mix');
    const dark = block(':root');
    const themes = {
      dark,
      light: { ...dark, ...block(':root[data-theme="light"]') },
      ash: { ...dark, ...block(':root[data-theme="ash"]') },
      onyx: { ...dark, ...block(':root[data-theme="onyx"]') }
    };
    for (const [name, theme] of Object.entries(themes)) {
      const text = rgb(theme['text-default']);
      const chat = rgb(theme['bg-chat']);
      const cover = text.map((v, i) => Math.round((v * share + chat[i] * (100 - share)) / 100));
      const r = ratio(cover, chat);
      assert.ok(r >= 3, `${name}: spoiler cover ${r.toFixed(2)}:1`);
    }
  });
});

// --- 4: unreads across servers ----------------------------------------------------

describe('unreads cover every server', () => {
  test('a mention in another server shows in read states, and its channel list is fetchable', async () => {
    const sent = await api('POST', '/api/messages', { channel_id: 'chan-201', content: `hey <@user-me> ${Date.now()}` }, as('user-2'));
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const states = await api('GET', '/api/read-states/user-me', undefined, as('user-me'));
    assert.equal(states.status, 200);
    const row = states.body.find((r) => r.channel_id === 'chan-201');
    assert.ok(row && (row.unread || row.mention_count > 0), 'server-2 channel is unread for user-me');
    const detail = await api('GET', '/api/servers/server-2', undefined, as('user-me'));
    assert.equal(detail.status, 200);
    assert.ok(detail.body.channels.some((c) => c.id === 'chan-201'), 'the inbox can name the channel');
    // The client fetches every server's channels when the inbox opens.
    assert.match(read('src/App.jsx'), /if \(inboxOpen\) loadAllServerChannels\(\)/);
  });
});

// --- 5: audit log wording ---------------------------------------------------------

describe('audit log', () => {
  test('every action type the server writes has a translated label', () => {
    const written = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith('.js')) {
          const src = read(rel);
          for (const [, a, b] of src.matchAll(/actionType(?:\s*=)?:?\s*(?:[\w.]+\s*\?\s*)?'([A-Z_]+)'(?:\s*:\s*'([A-Z_]+)')?/g)) {
            written.add(a); if (b) written.add(b);
          }
        }
      }
    };
    walk('services');
    walk('routes');
    assert.ok(written.has('WEBHOOK_CREATE') && written.size > 20, [...written].join(','));
    const missing = [...written].filter((type) => !AUDIT_ACTION_KEYS[type]);
    assert.deepEqual(missing, []);
    for (const key of Object.values(AUDIT_ACTION_KEYS)) {
      assert.ok(en[key], `en ${key}`);
      assert.ok(th[key], `th ${key}`);
    }
    assert.equal(auditActionLabel('WEBHOOK_CREATE', t), 'Webhook created');
    assert.equal(auditActionLabel('SOMETHING_NEW', t), 'Other change');
    assert.doesNotMatch(read('src/components/ServerSettingsModal.jsx'), /\?\? entry\.action_type/);
  });

  test('changes are readable and never show paths, URLs or JSON', () => {
    const fmt = (change) => formatAuditChange(change, {
      t, resolveChannel: (id) => (id === 'chan-102' ? 'general-chat' : null), resolveRole: (id) => (id === 'role-1-mod' ? 'Moderator' : null)
    });
    assert.deepEqual(fmt({ key: 'banner_url', new: '/uploads/banners/b0/d7/abc.png' }), { label: 'Banner', updated: 'updated' });
    assert.deepEqual(fmt({ key: 'icon_url', old: '/api/media/proxy?url=https%3A%2F%2Fimages.example', new: '/uploads/icons/x.png' }), { label: 'Icon', updated: 'updated' });
    assert.deepEqual(fmt({ key: 'profile_overrides', new: '{"a":1}' }), { label: 'Profile overrides', updated: 'updated' });
    assert.deepEqual(fmt({ key: 'topic', new: 'Monthly Town Hall — Q&A' }), { label: 'Topic', from: null, to: 'Monthly Town Hall — Q&A' });
    assert.deepEqual(fmt({ key: 'name', old: 'old', new: 'new' }), { label: 'Name', from: 'old', to: 'new' });
    assert.deepEqual(fmt({ key: 'nsfw', old: 0, new: 1 }), { label: 'Age-restricted', from: 'Off', to: 'On' });
    assert.deepEqual(fmt({ key: 'system_channel_id', new: 'chan-102' }), { label: 'System channel (welcome messages)', from: null, to: '#general-chat' });
    assert.deepEqual(fmt({ key: '$remove', new: 'role-1-mod' }), { label: 'Role removed', from: null, to: '@Moderator' });
    assert.equal(fmt({ key: 'icon_file_id', new: 'abc' }), null);
    for (const change of [
      { key: 'splash_url', new: 'https://cdn.example.com/a.webp' },
      { key: 'rules', new: [{ a: 1 }] },
      { key: 'avatar', new: 'data:image/png;base64,AAAA' }
    ]) {
      const out = JSON.stringify(fmt(change));
      assert.doesNotMatch(out, /\/uploads|https?:|data:|[{[]"?a/, out);
    }
  });

  test('a real webhook entry comes back with a known type and printable changes', async () => {
    const created = await api('POST', '/api/channels/chan-102/webhooks', { name: `Tour hook ${Date.now()}` }, as('user-me'));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const log = await api('GET', '/api/servers/server-1/audit-log?limit=20', undefined, as('user-me'));
    assert.equal(log.status, 200);
    const entry = log.body.find((e) => e.action_type === 'WEBHOOK_CREATE');
    assert.ok(entry, 'WEBHOOK_CREATE entry');
    assert.notEqual(auditActionLabel(entry.action_type, t), 'WEBHOOK_CREATE');
    for (const change of entry.changes ?? []) {
      const out = formatAuditChange(change, { t });
      if (out) assert.doesNotMatch(JSON.stringify(out), /\/uploads|https?:/);
    }
  });
});

// --- 7: quick switcher ------------------------------------------------------------

test('quick switcher lists the channel you are in', () => {
  const pool = [
    { id: 'chan-102', label: 'general-chat', unread: 0 },
    { id: 'chan-103', label: 'General Voice', unread: 0 },
    { id: 'chan-104', label: 'memes', unread: 0 }
  ];
  const hits = rankSwitcherEntries(pool, 'gen', { activeId: 'chan-102' });
  assert.deepEqual(hits.map((e) => e.id), ['chan-103', 'chan-102']);
  assert.deepEqual(rankSwitcherEntries(pool, 'general-c', { activeId: 'chan-102' }).map((e) => e.id), ['chan-102']);
  assert.deepEqual(rankSwitcherEntries(pool, '', {}), []);
  assert.doesNotMatch(read('src/components/QuickSwitcher.jsx'), /c\.type !== 'category' && c\.id !== activeChannelId/);
});

// --- 12: plural counts ------------------------------------------------------------

test('the admin summary uses plural forms in every language', () => {
  const dir = path.join(ROOT, 'src/i18n/locales');
  const dicts = { en, th };
  return Promise.all(fs.readdirSync(dir).filter((f) => /^[a-z]{2}(-[A-Z0-9]+)?\.js$/.test(f)).map(async (f) => {
    dicts[f.replace(/\.js$/, '')] = (await import(path.join(dir, f))).default;
  })).then(() => {
    assert.ok(Object.keys(dicts).length >= 31);
    for (const [name, dict] of Object.entries(dicts)) {
      for (const key of ['admin.summaryAccounts', 'admin.summaryServers', 'admin.summaryReports']) {
        assert.ok(dict[key]?.includes('{count}'), `${name} ${key}`);
        assert.ok(dict[`${key}_one`]?.includes('{count}'), `${name} ${key}_one`);
      }
    }
    assert.equal(en['admin.summaryReports_one'].replace('{count}', '1'), '1 open report');
    assert.match(read('src/components/admin/AdminConsole.jsx'), /t\('admin\.summaryReports', \{ count:/);
  });
});

// --- 16: routes -------------------------------------------------------------------

test('/discover and unknown paths are routed', () => {
  const app = read('src/App.jsx');
  assert.match(app, /parts\[0\] === 'discover'/);
  assert.match(app, /return \{ notFound: true \}/);
  assert.match(app, /setCanonicalPath\('\/discover'\)/);
  assert.match(app, /<NotFoundView/);
  for (const key of ['notFound.title', 'notFound.body', 'notFound.goHome']) {
    assert.ok(en[key] && th[key] && en[key] !== th[key], key);
  }
});

// --- 24: Thai wording -------------------------------------------------------------

test('Thai localises the ESC hint and Webhooks', () => {
  assert.equal(th['settings.escHint'], 'กด ESC');
  assert.equal(th['settings.webhooks'], 'เว็บฮุก');
  for (const file of ['src/components/ServerSettingsModal.jsx', 'src/components/UserSettingsModal.jsx']) {
    const src = read(file);
    assert.match(src, /t\('settings\.escHint'\)/, file);
    assert.doesNotMatch(src, />\s*ESC\s*</, file);
  }
});

// --- 17: welcome copy -------------------------------------------------------------

test('group DMs, threads and forum posts get their own welcome copy', () => {
  assert.equal(t('chat.welcomeToGroupDm', { name: 'Design squad' }), 'Welcome to Design squad!');
  assert.doesNotMatch(en['chat.welcomeToGroupDm'], /@/);
  assert.match(en['chat.forumPostStart'], /\{forum\}/);
  const chat = read('src/components/ChatArea.jsx');
  assert.match(chat, /introType === 'group_dm' \? t\('chat\.welcomeToGroupDm'/);
  assert.match(chat, /t\('chat\.forumPostStart'/);
});

// --- 25: announcements ------------------------------------------------------------

test('announcements join without doubled punctuation', () => {
  assert.equal(joinSentences(['You left the call.', 'Voice disconnected']), 'You left the call. Voice disconnected');
  assert.equal(joinSentences(['One', 'Two', '']), 'One. Two');
  assert.equal(joinSentences(['Really?', 'Yes!']), 'Really? Yes!');
  assert.doesNotMatch(read('src/components/chat/LiveAnnouncer.jsx'), /items\.join\('\. '\)/);
});
