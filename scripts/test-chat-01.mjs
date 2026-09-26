// Unit tests for the chat client's pure helpers (no server needed):
// history merging/capping, read-ack throttling, frame batching, emoji
// shortcodes, per-message language guessing and composer tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages, reconcile, capHistory } from '../src/chat/messageMerge.js';
import { createReadAcker, createFrameQueue } from '../src/chat/scheduling.js';
import { emojiFor, convertShortcodes, searchShortcodes, shortcodeLabel } from '../src/chat/emojiShortcodes.js';
import { guessLang } from '../src/chat/langGuess.js';
import { resolveComposerTokens } from '../src/utils/mentions.js';

const msg = (id, extra = {}) => ({ id: String(id), content: `m${id}`, created_at: new Date(1700000000000 + Number(id) * 1000).toISOString(), ...extra });

test('mergeMessages de-duplicates a page that arrives twice and keeps order', () => {
  const base = [msg(10), msg(11), msg(12)];
  const older = [msg(7), msg(8), msg(9)];
  const once = mergeMessages(base, older);
  const twice = mergeMessages(once, older);
  assert.deepEqual(twice.map((m) => m.id), ['7', '8', '9', '10', '11', '12']);
  assert.equal(twice, once, 'a duplicate page returns the same array (no re-render)');
});

test('mergeMessages orders snowflakes numerically, not lexically', () => {
  const list = mergeMessages([msg(99)], [msg(100), msg(98)]);
  assert.deepEqual(list.map((m) => m.id), ['98', '99', '100']);
});

test('mergeMessages replaces a pending message by nonce and keeps local ones last', () => {
  const pending = { id: 'pending-a', nonce: 'a', pending: true, content: 'hi' };
  const failed = { id: 'pending-b', nonce: 'b', failed: true, content: 'no' };
  const next = mergeMessages([msg(1), pending, failed], [msg(2, { nonce: 'a' })]);
  assert.deepEqual(next.map((m) => m.id), ['1', '2', 'pending-b']);
});

test('reconcile keeps identity for unchanged messages', () => {
  const prev = [msg(1), msg(2)];
  const same = reconcile(prev, [msg(1), msg(2)]);
  assert.equal(same, prev);
  const edited = reconcile(prev, [msg(1), msg(2, { content: 'edited' })]);
  assert.equal(edited[0], prev[0]);
  assert.notEqual(edited[1], prev[1]);
});

test('capHistory drops from the far end and says which', () => {
  const list = Array.from({ length: 12 }, (_, i) => msg(i + 1));
  const newest = capHistory(list, { max: 10, keep: 'newest' });
  assert.equal(newest.list[0].id, '3');
  assert.equal(newest.droppedOlder, true);
  const oldest = capHistory(list, { max: 10, keep: 'oldest' });
  assert.equal(oldest.list.at(-1).id, '10');
  assert.equal(oldest.droppedNewer, true);
});

test('read acknowledgements: newest id wins, at most one emit per interval', async () => {
  const sent = [];
  const acker = createReadAcker((channel, id) => sent.push([channel, id]), { interval: 60 });
  for (let i = 1; i <= 100; i += 1) acker.queue('c1', String(i));
  assert.deepEqual(sent, [['c1', '1']], 'first ack is immediate');
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(sent, [['c1', '1'], ['c1', '100']], 'trailing ack carries the newest id');
  acker.queue('c1', '101');
  acker.flush();
  assert.deepEqual(sent.at(-1), ['c1', '101'], 'flush sends what is waiting');
});

test('frame queue runs queued jobs together', async () => {
  const queue = createFrameQueue();
  const ran = [];
  queue.push(() => ran.push(1));
  queue.push(() => ran.push(2));
  assert.deepEqual(ran, []);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(ran, [1, 2]);
});

test('emoji shortcodes convert outside code only', () => {
  assert.equal(emojiFor('fire'), '🔥');
  assert.equal(convertShortcodes('this is :fire: :notreal:'), 'this is 🔥 :notreal:');
  assert.equal(convertShortcodes('`:fire:` stays'), '`:fire:` stays');
  assert.equal(convertShortcodes('12:30:45'), '12:30:45');
  assert.equal(searchShortcodes('thumbs')[0].char, '👍');
  assert.equal(shortcodeLabel('👍'), ':thumbsup:');
});

test('composer tokens: custom emoji first, unicode shortcode fallback', () => {
  const out = resolveComposerTokens(':party: :tada:', { customEmojis: [{ id: '5', name: 'party' }] });
  assert.equal(out, '<:party:5> 🎉');
});

test('guessLang picks the script of the message', () => {
  assert.equal(guessLang('สวัสดีครับ วันนี้ทำงานไหม'), 'th');
  assert.equal(guessLang('今日はいい天気ですね'), 'ja');
  assert.equal(guessLang('你好，今天天气很好'), 'zh');
  assert.equal(guessLang('안녕하세요 반갑습니다'), 'ko');
  assert.equal(guessLang('hello there, how are you'), null);
  assert.equal(guessLang('see https://example.com/สวัสดี ok thanks'), null, 'links are not prose');
});
