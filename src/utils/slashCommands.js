// ============================================================================
//  Slash commands.
//
//  Discord's built-in set falls into two kinds, and keeping them apart is what
//  makes this simple:
//
//    transform — rewrites what you typed and sends it as an ordinary message
//                (/me, /shrug, /spoiler). No server involvement at all.
//    action    — does something instead of sending text (/poll, /nick, /leave).
//                The composer hands these to a handler.
//
//  Anything a transform can do, the user could have typed by hand. That is the
//  point: they are shortcuts, not privileges, so there is nothing to authorise
//  and nothing new the server has to trust.
// ============================================================================

import { t } from '../i18n/index.jsx';

/**
 * `run` returns what to send: `{ content }` for a transform, or `{ action }`
 * for something the composer must handle. Returning `null` means "swallow it",
 * which is how /shrug with no argument still works.
 */
export const SLASH_COMMANDS = () => [
  {
    name: 'me',
    description: t('slash.me'),
    usage: '/me <message>',
    run: (rest) => (rest ? { content: `*${rest}*` } : null)
  },
  {
    name: 'shrug',
    description: t('slash.shrug'),
    usage: '/shrug [message]',
    run: (rest) => ({ content: `${rest} ¯\\_(ツ)_/¯`.trim() })
  },
  {
    name: 'tableflip',
    description: t('slash.tableflip'),
    usage: '/tableflip [message]',
    run: (rest) => ({ content: `${rest} (╯°□°）╯︵ ┻━┻`.trim() })
  },
  {
    name: 'unflip',
    description: t('slash.unflip'),
    usage: '/unflip [message]',
    run: (rest) => ({ content: `${rest} ┬─┬ ノ( ゜-゜ノ)`.trim() })
  },
  {
    name: 'spoiler',
    description: t('slash.spoiler'),
    usage: '/spoiler <message>',
    run: (rest) => (rest ? { content: `||${rest}||` } : null)
  },
  {
    name: 'tts',
    description: t('slash.tts'),
    usage: '/tts <message>',
    run: (rest) => (rest ? { content: rest, tts: true } : null)
  },
  {
    name: 'poll',
    description: t('slash.poll'),
    usage: '/poll',
    run: () => ({ action: 'poll' })
  },
  {
    name: 'nick',
    description: t('slash.nick'),
    usage: '/nick <name>',
    // An empty argument is meaningful here: it clears the nickname.
    run: (rest) => ({ action: 'nick', value: rest })
  },
  {
    name: 'search',
    description: t('slash.search'),
    usage: '/search <query>',
    run: (rest) => (rest ? { action: 'search', value: rest } : null)
  },
  {
    name: 'thread',
    description: t('slash.thread'),
    usage: '/thread <name>',
    run: (rest) => (rest ? { action: 'thread', value: rest } : null)
  }
];

/**
 * Is this text a slash command being typed?
 *
 * Only at the very start, and only when there is no space yet — otherwise
 * "10/10 would recommend" and a URL both start looking like commands.
 */
export function parseSlashInput(text) {
  if (!text.startsWith('/')) return null;
  const match = /^\/([a-zA-Z]*)(\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    rest: (match[3] ?? '').trim(),
    complete: match[2] !== undefined     // a space has been typed, so the name is settled
  };
}

/** Commands whose names start with `prefix`, for the autocomplete list. */
export function matchCommands(prefix) {
  const needle = (prefix ?? '').toLowerCase();
  return SLASH_COMMANDS().filter((command) => command.name.startsWith(needle));
}

/**
 * Resolve typed text to an outcome.
 *
 * Returns `{ unknown: true }` for `/notacommand` rather than silently sending
 * it as text — Discord refuses too, and quietly posting a typo'd command into
 * a channel is worse than a small error.
 */
export function runSlashCommand(text) {
  const parsed = parseSlashInput(text);
  if (!parsed || !parsed.complete) return null;

  const command = SLASH_COMMANDS().find((c) => c.name === parsed.name);
  if (!command) return { unknown: true, name: parsed.name };

  const result = command.run(parsed.rest);
  return result ? { ...result, handled: true } : { handled: true, empty: true };
}
