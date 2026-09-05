import React, { useState } from 'react';
import { t } from '../i18n/index.jsx';

/**
 * Discord-flavoured markdown renderer.
 *
 * Handled, block level:   ```code```, # ## ### headings, > quote, - / 1. lists,
 *                         -# subtext
 * Handled, inline:        **bold**, *italic*, __underline__, ~~strike~~,
 *                         `code`, ||spoiler||, [text](url), bare URLs,
 *                         <@user>, <@&role>, <#channel>, <:emoji:id>,
 *                         <t:unix:style> timestamps, @everyone / @here
 *
 * Deliberately hand-rolled rather than a markdown library: Discord's dialect is
 * not CommonMark (no setext headings, no reference links, spoilers and mentions
 * are extensions) and every node must be a React element so mentions stay
 * interactive.
 */

function SpoilerText({ children }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      onClick={(e) => { e.stopPropagation(); setRevealed(true); }}
      className={`px-1 py-0.5 rounded transition-all ${
        revealed
          ? 'bg-d-surface text-d-text'
          : 'bg-d-sunken text-transparent select-none cursor-pointer hover:bg-d-edge'
      }`}
      title={revealed ? undefined : t('chat.clickToReveal')}
    >
      {children}
    </span>
  );
}

const MENTION_CLASS =
  'bg-d-brand/20 text-d-mention font-medium px-1 py-0.5 rounded ' +
  'hover:bg-d-brand hover:text-white cursor-pointer transition-colors';

/** Discord's <t:unix:style> — R is relative, others are absolute formats. */
function renderTimestamp(unix, style = 'f') {
  const date = new Date(Number(unix) * 1000);
  if (Number.isNaN(date.getTime())) return `<t:${unix}>`;

  if (style === 'R') {
    const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
    const abs = Math.abs(diffSec);
    const units = [
      ['year', 31536000], ['month', 2592000], ['day', 86400],
      ['hour', 3600], ['minute', 60], ['second', 1]
    ];
    const [unit, secs] = units.find(([, s]) => abs >= s) ?? ['second', 1];
    const rtf = new Intl.RelativeTimeFormat('th-TH', { numeric: 'auto' });
    return rtf.format(Math.round(diffSec / secs), unit);
  }

  const options = {
    t: { hour: '2-digit', minute: '2-digit' },
    T: { hour: '2-digit', minute: '2-digit', second: '2-digit' },
    d: { day: '2-digit', month: '2-digit', year: 'numeric' },
    D: { day: 'numeric', month: 'long', year: 'numeric' },
    f: { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' },
    F: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }
  }[style] ?? { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' };

  return date.toLocaleString('th-TH', options);
}

// Order matters: longer delimiters must be tried before their prefixes, so
// ``` before `, ** before *, and __ before _.
//
// Kept as a *source string*, not a shared RegExp: renderInline recurses into
// itself for nested markup like **bold *italic***, and a module-level /g regex
// carries `lastIndex` between those nested calls — which corrupts the outer
// scan and can spin forever.
const INLINE_SOURCE = [
  '\\|\\|[\\s\\S]+?\\|\\|',                 // spoiler
  '`[^`\\n]+`',                             // inline code
  // Lazy [\s\S]+? rather than [^*]+ so a nested span survives:
  // **bold *italic* more** must match the whole bold run, then recurse.
  '\\*\\*\\*[\\s\\S]+?\\*\\*\\*',           // bold italic
  '\\*\\*[\\s\\S]+?\\*\\*',                 // bold
  '__[\\s\\S]+?__',                         // underline
  '~~[\\s\\S]+?~~',                         // strikethrough
  // Emphasis needs a non-space next to each delimiter, otherwise arithmetic
  // like "2 * 3 * 4" turns italic.
  '\\*(?!\\*)(?!\\s)[^\\n]+?(?<!\\s)\\*(?!\\*)',
  // Underscore emphasis only at word boundaries, so snake_case_names survive.
  '(?<![\\p{L}\\p{N}_])_(?!_)(?!\\s)[^\\n]+?(?<!\\s)_(?!_)(?![\\p{L}\\p{N}_])',
  '<a?:\\w+:\\d+>',                         // custom emoji
  '<@!?[\\w-]+>',                           // user mention
  '<@&[\\w-]+>',                            // role mention
  '<#[\\w-]+>',                             // channel mention
  '<t:\\d+(?::[tTdDfFR])?>',                // timestamp
  '\\[[^\\]\\n]+\\]\\((?:https?:\\/\\/|\\/)[^)\\s]+\\)', // markdown link
  'https?:\\/\\/[^\\s<]+',                  // bare URL
  '@(?:everyone|here)\\b'                   // mass mention
].join('|');

function renderInline(text, keyPrefix, context) {
  const nodes = [];
  let cursor = 0;
  let match;
  // Fresh regex per invocation — see the note on INLINE_SOURCE.
  const pattern = new RegExp(INLINE_SOURCE, 'gu');

  while ((match = pattern.exec(text)) !== null) {
    // Zero-length match would never advance the cursor.
    if (match[0].length === 0) { pattern.lastIndex += 1; continue; }

    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    nodes.push(renderToken(token, key, context));
    cursor = match.index + token.length;
    pattern.lastIndex = cursor;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderToken(token, key, context) {
  const inner = (open, close = open) =>
    renderInline(token.slice(open.length, -close.length), `${key}i`, context);

  if (token.startsWith('||')) return <SpoilerText key={key}>{token.slice(2, -2)}</SpoilerText>;

  if (token.startsWith('`')) {
    return (
      <code key={key} className="bg-d-base text-d-text px-1.5 py-0.5 rounded font-mono text-[0.85em]">
        {token.slice(1, -1)}
      </code>
    );
  }

  if (token.startsWith('***')) return <strong key={key} className="font-bold text-d-strong"><em>{inner('***')}</em></strong>;
  if (token.startsWith('**'))  return <strong key={key} className="font-bold text-d-strong">{inner('**')}</strong>;
  if (token.startsWith('__'))  return <u key={key}>{inner('__')}</u>;
  if (token.startsWith('~~'))  return <s key={key} className="opacity-70">{inner('~~')}</s>;
  if (token.startsWith('*'))   return <em key={key} className="italic">{inner('*')}</em>;
  if (token.startsWith('_'))   return <em key={key} className="italic">{inner('_')}</em>;

  // Custom emoji: <:name:id> or <a:name:id> for animated.
  const emoji = token.match(/^<(a?):(\w+):(\d+)>$/);
  if (emoji) {
    const [, animated, name, id] = emoji;
    const url = context.emojiUrl?.(id) ?? `/api/emojis/${id}/image`;
    return (
      <img
        key={key}
        src={url}
        alt={`:${name}:`}
        title={`:${name}:`}
        className={`inline-block w-[1.375em] h-[1.375em] align-[-0.3em] mx-[1px] ${animated ? '' : ''}`}
      />
    );
  }

  const userMention = token.match(/^<@!?([\w-]+)>$/);
  if (userMention) {
    const id = userMention[1];
    const name = context.resolveUser?.(id) ?? id;
    return (
      <span key={key} className={MENTION_CLASS} onClick={() => context.onMentionClick?.(id)}>
        @{name}
      </span>
    );
  }

  const roleMention = token.match(/^<@&([\w-]+)>$/);
  if (roleMention) {
    const role = context.resolveRole?.(roleMention[1]);
    return (
      <span
        key={key}
        className="font-medium px-1 py-0.5 rounded cursor-pointer transition-colors"
        style={{
          color: role?.color ?? '#c9cdfb',
          backgroundColor: `${role?.color ?? '#5865f2'}33`
        }}
      >
        @{role?.name ?? roleMention[1]}
      </span>
    );
  }

  const channelMention = token.match(/^<#([\w-]+)>$/);
  if (channelMention) {
    const id = channelMention[1];
    return (
      <span
        key={key}
        className={MENTION_CLASS}
        onClick={() => context.onChannelClick?.(id)}
      >
        #{context.resolveChannel?.(id) ?? id}
      </span>
    );
  }

  const timestamp = token.match(/^<t:(\d+)(?::([tTdDfFR]))?>$/);
  if (timestamp) {
    return (
      <span key={key} className="bg-d-active text-d-text px-1 rounded" title={new Date(Number(timestamp[1]) * 1000).toISOString()}>
        {renderTimestamp(timestamp[1], timestamp[2])}
      </span>
    );
  }

  const link = token.match(/^\[([^\]]+)\]\((.+)\)$/);
  if (link) {
    return (
      <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener"
         className="text-d-link hover:underline">
        {link[1]}
      </a>
    );
  }

  if (token.startsWith('http')) {
    return (
      <a key={key} href={token} target="_blank" rel="noreferrer noopener"
         className="text-d-link hover:underline break-all">
        {token}
      </a>
    );
  }

  if (token.startsWith('@')) {
    return (
      <span key={key} className="bg-d-brand/30 text-d-mention font-semibold px-1 rounded">
        {token}
      </span>
    );
  }

  return token;
}

const HEADING_SIZES = ['text-2xl', 'text-xl', 'text-lg'];

/** Render one non-code block: headings, quotes, lists, subtext, plain lines. */
function renderBlock(block, keyPrefix, context) {
  const lines = block.split('\n');
  const out = [];
  let listBuffer = null; // { ordered, items[] }

  const flushList = () => {
    if (!listBuffer) return;
    const Tag = listBuffer.ordered ? 'ol' : 'ul';
    out.push(
      <Tag
        key={`${keyPrefix}-list-${out.length}`}
        className={`${listBuffer.ordered ? 'list-decimal' : 'list-disc'} pl-6 my-0.5 space-y-0.5`}
      >
        {listBuffer.items.map((item, i) => (
          <li key={i}>{renderInline(item, `${keyPrefix}-li-${i}`, context)}</li>
        ))}
      </Tag>
    );
    listBuffer = null;
  };

  lines.forEach((line, index) => {
    const key = `${keyPrefix}-l${index}`;

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const Tag = `h${level}`;
      out.push(
        <Tag key={key} className={`${HEADING_SIZES[level - 1]} font-bold text-white mt-2 mb-1`}>
          {renderInline(heading[2], key, context)}
        </Tag>
      );
      return;
    }

    // Discord's small-text line.
    const subtext = line.match(/^-#\s+(.*)$/);
    if (subtext) {
      flushList();
      out.push(
        <div key={key} className="text-xs text-d-text3">
          {renderInline(subtext[1], key, context)}
        </div>
      );
      return;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushList();
      out.push(
        <blockquote key={key} className="border-l-4 border-d-control pl-3 my-0.5 text-d-text">
          {renderInline(quote[1], key, context)}
        </blockquote>
      );
      return;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (!listBuffer || listBuffer.ordered !== ordered) {
        flushList();
        listBuffer = { ordered, items: [] };
      }
      listBuffer.items.push((bullet ?? numbered)[1]);
      return;
    }

    flushList();
    if (line.trim() === '') {
      out.push(<span key={key}>{'\n'}</span>);
    } else {
      out.push(
        <span key={key}>
          {renderInline(line, key, context)}
          {index < lines.length - 1 ? '\n' : null}
        </span>
      );
    }
  });

  flushList();
  return out;
}

const CODE_BLOCK_SOURCE = '```(?:([\\w+-]+)\\n)?([\\s\\S]*?)```';

/**
 * @param content raw message text
 * @param context optional resolvers: { resolveUser, resolveRole, resolveChannel,
 *                emojiUrl, onMentionClick, onChannelClick }
 */
export function parseDiscordMarkdown(content, context = {}) {
  if (!content) return null;

  const parts = [];
  let lastIndex = 0;
  let match;
  const codeBlock = new RegExp(CODE_BLOCK_SOURCE, 'g');

  while ((match = codeBlock.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'code', lang: match[1] || 'plaintext', code: match[2].replace(/\n$/, '') });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push({ type: 'text', content: content.slice(lastIndex) });
  }

  return parts.map((part, index) => {
    if (part.type === 'code') {
      return (
        <div
          key={index}
          className="my-2 bg-d-base border border-d-surface rounded-lg overflow-hidden"
        >
          <div className="flex items-center justify-between px-3 pt-2">
            <span className="text-[10px] font-bold text-d-text4 uppercase">{part.lang}</span>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(part.code)}
              className="text-[10px] text-d-text4 hover:text-d-strong transition-colors"
            >
              {t('common.copy')}
            </button>
          </div>
          <pre className="px-3 pb-3 pt-1 font-mono text-xs text-d-text2 overflow-x-auto whitespace-pre">
            <code>{part.code}</code>
          </pre>
        </div>
      );
    }
    return <span key={index}>{renderBlock(part.content, `b${index}`, context)}</span>;
  });
}
