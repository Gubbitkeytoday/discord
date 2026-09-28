// ============================================================================
//  Plain-text summaries of Discord-flavoured markdown.
//
//  One-line previews — the inbox, reply spines, search hits, forum cards,
//  message requests — cannot hold the full renderer (block quotes, code
//  blocks, clickable pills), but they must not show the wire format either:
//  `<@1553…>`, `**bold**`, `||secret||`. `markdownToPlain` walks the same
//  token grammar as the renderer (./markdownTokens.js) and returns what a
//  reader would see: names instead of ids, markup removed, spoilers hidden.
//
//  Pure: no React, no DOM, no i18n import — callers pass the few words it
//  needs, which keeps it testable from Node.
// ============================================================================

import { INLINE_SOURCE, CODE_BLOCK_SOURCE } from './markdownTokens.js';

/**
 * @param {string} content  raw message text
 * @param {object} [options]
 * @param {(id: string) => string|null} [options.resolveUser]     display name for a user id
 * @param {(id: string) => string|null} [options.resolveChannel]  name for a channel id
 * @param {(id: string) => ({ name?: string }|string|null)} [options.resolveRole]
 * @param {string}  [options.unknownUser='unknown-user']  shown for ids nobody can name
 * @param {string}  [options.unknownChannel='unknown-channel']
 * @param {string}  [options.unknownRole='unknown-role']
 * @param {string}  [options.spoiler='▮▮▮']  what a spoiler becomes (its text is never shown)
 * @param {boolean} [options.singleLine=true] collapse line breaks and runs of spaces
 * @param {string}  [options.locale]  for <t:…> timestamps
 */
export function markdownToPlain(content, options = {}) {
  if (content === null || content === undefined) return '';
  const text = String(content);
  if (!text) return '';
  const opts = {
    unknownUser: 'unknown-user',
    unknownChannel: 'unknown-channel',
    unknownRole: 'unknown-role',
    spoiler: '▮▮▮',
    singleLine: true,
    ...options
  };

  // Code blocks keep their code (it is content), minus the fences and language.
  const pieces = [];
  const fence = new RegExp(CODE_BLOCK_SOURCE, 'g');
  let last = 0;
  let match;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) pieces.push(blocks(text.slice(last, match.index), opts));
    pieces.push(match[2].replace(/\n$/, ''));
    last = match.index + match[0].length;
  }
  if (last < text.length) pieces.push(blocks(text.slice(last), opts));

  const out = pieces.join(opts.singleLine ? ' ' : '\n');
  return opts.singleLine ? out.replace(/\s+/g, ' ').trim() : out.replace(/[ \t]+\n/g, '\n').trim();
}

/** Block-level markers (headings, quotes, subtext, list bullets) per line. */
function blocks(chunk, opts) {
  return chunk.split('\n').map((line) => {
    let body = line;
    let prefix = '';
    const heading = body.match(/^#{1,3}\s+(.*)$/);
    if (heading) body = heading[1];
    const subtext = body.match(/^-#\s+(.*)$/);
    if (subtext) body = subtext[1];
    const quote = body.match(/^>{1,3}\s?(.*)$/);
    if (quote) body = quote[1];
    const bullet = body.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { body = bullet[1]; prefix = '• '; }
    return prefix + inline(body, opts);
  }).join('\n');
}

function inline(text, opts) {
  let out = '';
  let cursor = 0;
  let match;
  const pattern = new RegExp(INLINE_SOURCE, 'gu');
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) { pattern.lastIndex += 1; continue; }
    out += text.slice(cursor, match.index) + token(match[0], opts);
    cursor = match.index + match[0].length;
    pattern.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

function nameOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value.name ?? null;
  return String(value);
}

function token(tok, opts) {
  const inner = (open, close = open) => inline(tok.slice(open.length, -close.length), opts);

  if (tok.length === 2 && tok[0] === '\\') return tok[1];
  if (tok.startsWith('||')) return opts.spoiler;
  if (tok.startsWith('`')) return tok.slice(1, -1);
  if (tok.startsWith('***')) return inner('***');
  if (tok.startsWith('**')) return inner('**');
  if (tok.startsWith('__')) return inner('__');
  if (tok.startsWith('~~')) return inner('~~');
  if (tok.startsWith('*')) return inner('*');
  if (tok.startsWith('_')) return inner('_');

  const emoji = tok.match(/^<a?:(\w+):\d+>$/);
  if (emoji) return `:${emoji[1]}:`;

  const user = tok.match(/^<@!?([\w-]+)>$/);
  if (user) return `@${nameOf(opts.resolveUser?.(user[1])) || opts.unknownUser}`;

  const role = tok.match(/^<@&([\w-]+)>$/);
  if (role) return `@${nameOf(opts.resolveRole?.(role[1])) || opts.unknownRole}`;

  const channel = tok.match(/^<#([\w-]+)>$/);
  if (channel) return `#${nameOf(opts.resolveChannel?.(channel[1])) || opts.unknownChannel}`;

  const stamp = tok.match(/^<t:(\d+)(?::([tTdDfFR]))?>$/);
  if (stamp) {
    const date = new Date(Number(stamp[1]) * 1000);
    if (Number.isNaN(date.getTime())) return tok;
    try {
      return date.toLocaleString(opts.locale, stamp[2] === 't' || stamp[2] === 'T'
        ? { hour: '2-digit', minute: '2-digit' }
        : { dateStyle: 'medium', ...(stamp[2] === 'd' || stamp[2] === 'D' ? {} : { timeStyle: 'short' }) });
    } catch { return date.toISOString(); }
  }

  const link = tok.match(/^\[([^\]]+)\]\((.+)\)$/);
  if (link) return inline(link[1], opts);

  return tok; // bare URLs, @everyone / @here
}

/**
 * Join screen-reader announcements that arrived together into one utterance
 * without doubled punctuation ("You left the call.. Voice disconnected").
 */
export function joinSentences(items) {
  return (items ?? [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .map((item, index, all) => (index < all.length - 1 && !/[.!?…。！？]$/u.test(item) ? `${item}.` : item))
    .join(' ');
}
