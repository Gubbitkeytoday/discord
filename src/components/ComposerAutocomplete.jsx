import React, { useEffect, useMemo, useRef } from 'react';
import { AtSign, Hash, Smile, Slash } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import { matchCommands } from '../utils/slashCommands';
import { DEFAULT_AVATAR } from '../utils/avatar';

const FALLBACK_AVATAR = DEFAULT_AVATAR;

/**
 * A small emoji set for `:name:` completion. Real Discord ships the full
 * unicode table plus per-guild custom emoji; custom emoji from the server are
 * merged in by the caller.
 */
export const EMOJI_TABLE = [
  { name: 'smile', char: '😄' }, { name: 'grin', char: '😁' }, { name: 'joy', char: '😂' },
  { name: 'rofl', char: '🤣' }, { name: 'wink', char: '😉' }, { name: 'blush', char: '😊' },
  { name: 'heart_eyes', char: '😍' }, { name: 'thinking', char: '🤔' }, { name: 'sunglasses', char: '😎' },
  { name: 'cry', char: '😢' }, { name: 'sob', char: '😭' }, { name: 'angry', char: '😠' },
  { name: 'scream', char: '😱' }, { name: 'sleeping', char: '😴' }, { name: 'nerd', char: '🤓' },
  { name: 'heart', char: '❤️' }, { name: 'broken_heart', char: '💔' }, { name: 'sparkles', char: '✨' },
  { name: 'fire', char: '🔥' }, { name: 'star', char: '⭐' }, { name: 'zap', char: '⚡' },
  { name: 'tada', char: '🎉' }, { name: 'rocket', char: '🚀' }, { name: 'hundred', char: '💯' },
  { name: 'thumbsup', char: '👍' }, { name: 'thumbsdown', char: '👎' }, { name: 'clap', char: '👏' },
  { name: 'pray', char: '🙏' }, { name: 'wave', char: '👋' }, { name: 'muscle', char: '💪' },
  { name: 'eyes', char: '👀' }, { name: 'skull', char: '💀' }, { name: 'poop', char: '💩' },
  { name: 'check', char: '✅' }, { name: 'x', char: '❌' }, { name: 'warning', char: '⚠️' },
  { name: 'cat', char: '🐱' }, { name: 'dog', char: '🐶' }, { name: 'fox', char: '🦊' },
  { name: 'pizza', char: '🍕' }, { name: 'coffee', char: '☕' }, { name: 'beer', char: '🍺' },
  { name: 'gamepad', char: '🎮' }, { name: 'headphones', char: '🎧' }, { name: 'computer', char: '💻' }
];

// The command table lives in utils/slashCommands.js so the composer and the
// executor cannot drift apart — an entry here that the runner does not know
// would autocomplete into a message that then refuses to send.
export { SLASH_COMMANDS as slashCommands } from '../utils/slashCommands';

/**
 * Find the token the caret is currently inside, if it is a completion trigger.
 * Returns { kind, query, start } or null.
 *
 * A trigger only counts at the start of the message (`/`) or after whitespace
 * (`@`, `#`, `:`) — otherwise an email address or a URL would open the popup.
 */
export function detectTrigger(text, caret) {
  const before = text.slice(0, caret);

  const slash = before.match(/^\/(\w*)$/);
  if (slash) return { kind: 'command', query: slash[1], start: 0 };

  const match = before.match(/(^|\s)([@#:])([\p{L}\p{N}_-]*)$/u);
  if (!match) return null;

  const [, lead, symbol, query] = match;
  // `:` needs at least two characters before it searches, or every ":" in a URL
  // or a time like 12:30 would trigger it.
  if (symbol === ':' && query.length < 2) return null;

  return {
    kind: symbol === '@' ? 'user' : symbol === '#' ? 'channel' : 'emoji',
    query,
    start: before.length - query.length - 1,
    lead: lead.length
  };
}

const kindMeta = () => ({
  user:    { icon: AtSign, label: t('autocomplete.members') },
  channel: { icon: Hash,   label: t('autocomplete.channels') },
  emoji:   { icon: Smile,  label: t('chat.emoji') },
  command: { icon: Slash,  label: t('autocomplete.commands') }
});

/** Build the ranked option list for a trigger. */
export function buildOptions(trigger, { members = [], channels = [], customEmojis = [], botCommands = [] }) {
  if (!trigger) return [];
  const q = trigger.query.toLowerCase();

  if (trigger.kind === 'user') {
    return members
      .filter((m) =>
        (m.display_name ?? '').toLowerCase().includes(q) ||
        (m.username ?? '').toLowerCase().includes(q))
      // Prefix matches rank above substring matches.
      .sort((a, b) => {
        const aStarts = (a.username ?? '').toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = (b.username ?? '').toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts;
      })
      .slice(0, 10)
      .map((m) => ({
        id: m.id,
        primary: m.display_name || m.username,
        secondary: `@${m.username}`,
        avatar: m.avatar_url,
        color: m.role_color,
        insert: `<@${m.id}> `
      }));
  }

  if (trigger.kind === 'channel') {
    return channels
      .filter((c) => c.type !== 'category' && (c.name ?? '').toLowerCase().includes(q))
      .slice(0, 10)
      .map((c) => ({
        id: c.id,
        primary: c.name,
        secondary: c.category ?? '',
        insert: `<#${c.id}> `
      }));
  }

  if (trigger.kind === 'emoji') {
    const custom = customEmojis
      .filter((e) => e.name.toLowerCase().includes(q))
      .map((e) => ({
        id: e.id,
        primary: `:${e.name}:`,
        secondary: t('autocomplete.serverEmoji'),
        image: e.url,
        insert: `<:${e.name}:${e.id}> `
      }));
    const unicode = EMOJI_TABLE
      .filter((e) => e.name.includes(q))
      .map((e) => ({
        id: e.name,
        primary: `:${e.name}:`,
        secondary: e.char,
        emoji: e.char,
        insert: `${e.char} `
      }));
    return [...custom, ...unicode].slice(0, 10);
  }

  // Built-ins first, then whatever the bots in this channel registered. A bot
  // command is marked so the composer knows to POST it instead of running it
  // locally.
  const builtIn = matchCommands(q).map((c) => ({
    id: c.name,
    primary: `/${c.name}`,
    secondary: c.description,
    command: c,
    // Completing inserts the name and a space; the command only *runs* when
    // the message is sent, so you can still type its argument.
    insert: `/${c.name} `
  }));
  const taken = new Set(builtIn.map((o) => o.id));
  const fromBots = botCommands
    // Context-menu commands are not typed — they live in a right-click menu,
    // and offering them here would suggest a slash that does not exist.
    .filter((c) => (c.type ?? 'slash') === 'slash')
    .filter((c) => c.name.startsWith(q) && !taken.has(c.name))
    .map((c) => ({
      id: `bot:${c.application_id}:${c.name}`,
      primary: `/${c.name}`,
      secondary: `${c.description} · ${c.application_name}`,
      botCommand: c,
      insert: `/${c.name} `
    }));
  return [...builtIn, ...fromBots].slice(0, 12);
}

/**
 * The popup itself. Purely presentational — selection state and keyboard
 * handling live in the composer so Enter/Tab/arrows compose with sending.
 */
export default function ComposerAutocomplete({ trigger, options, activeIndex, onPick }) {
  const listRef = useRef(null);

  // Keep the highlighted row in view when arrowing past the visible window.
  useEffect(() => {
    const node = listRef.current?.children?.[activeIndex];
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const meta = useMemo(() => kindMeta()[trigger?.kind] ?? kindMeta().user, [trigger?.kind]);
  if (!trigger || options.length === 0) return null;

  const Icon = meta.icon;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 bg-d-surface border border-d-edge rounded-lg shadow-2xl overflow-hidden z-40">
      <div className="px-3 py-2 text-[11px] font-bold text-d-text3 uppercase tracking-wide border-b border-d-edge flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5" />
        {meta.label}
        <span className="ml-auto font-normal normal-case text-[10px]">
          {t('autocomplete.hint')}
        </span>
      </div>

      <div ref={listRef} className="max-h-60 overflow-y-auto py-1">
        {options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onPick(option); }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
              index === activeIndex ? 'bg-d-active' : 'hover:bg-d-hover'
            }`}
          >
            {option.avatar && (
              <img src={option.avatar || FALLBACK_AVATAR} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
            )}
            {option.image && <img src={option.image} alt="" className="w-6 h-6 object-contain shrink-0" />}
            {option.emoji && <span className="w-6 text-center text-lg shrink-0">{option.emoji}</span>}

            <span
              className="text-sm font-medium truncate"
              style={option.color ? { color: option.color } : undefined}
            >
              {option.primary}
            </span>
            {option.secondary && (
              <span className="text-xs text-d-text3 truncate ml-auto pl-2">{option.secondary}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
