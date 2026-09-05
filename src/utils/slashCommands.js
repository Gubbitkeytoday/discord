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
  },

  // --- text transforms (no server involvement) ------------------------------
  {
    name: 'code',
    description: t('slash.code'),
    usage: '/code <text>',
    run: (rest) => (rest ? { content: rest.includes('\n') ? `\`\`\`\n${rest}\n\`\`\`` : `\`${rest}\`` } : null)
  },
  {
    name: 'quote',
    description: t('slash.quote'),
    usage: '/quote <text>',
    run: (rest) => (rest ? { content: rest.split('\n').map((line) => `> ${line}`).join('\n') } : null)
  },
  {
    name: 'bold',
    description: t('slash.bold'),
    usage: '/bold <text>',
    run: (rest) => (rest ? { content: `**${rest}**` } : null)
  },
  {
    name: 'italic',
    description: t('slash.italic'),
    usage: '/italic <text>',
    run: (rest) => (rest ? { content: `*${rest}*` } : null)
  },
  {
    name: 'lenny',
    description: t('slash.lenny'),
    usage: '/lenny [message]',
    run: (rest) => ({ content: `${rest} ( ͡° ͜ʖ ͡°)`.trim() })
  },
  {
    name: 'flip',
    description: t('slash.flip'),
    usage: '/flip',
    // A coin flip is a transform: the result is text, and everyone can see it
    // was the sender's client that flipped it — same as typing the answer.
    run: () => ({ content: Math.random() < 0.5 ? t('slash.heads') : t('slash.tails') })
  },
  {
    name: 'roll',
    description: t('slash.roll'),
    usage: '/roll [sides]',
    run: (rest) => {
      const sides = Math.min(1000, Math.max(2, Number(rest) || 6));
      return { content: t('slash.rolled', { n: 1 + Math.floor(Math.random() * sides), sides }) };
    }
  },

  // --- actions --------------------------------------------------------------
  {
    name: 'shout',
    description: t('slash.shout'),
    usage: '/shout <message>',
    run: (rest) => (rest ? { content: rest.toUpperCase() } : null)
  },
  {
    name: 'invite',
    description: t('slash.invite'),
    usage: '/invite',
    run: () => ({ action: 'invite' })
  },
  {
    name: 'leave',
    description: t('slash.leave'),
    usage: '/leave',
    run: () => ({ action: 'leave' })
  },
  {
    name: 'mute',
    description: t('slash.mute'),
    usage: '/mute',
    run: () => ({ action: 'mute-channel' })
  },
  {
    name: 'unmute',
    description: t('slash.unmute'),
    usage: '/unmute',
    run: () => ({ action: 'unmute-channel' })
  },
  {
    name: 'pins',
    description: t('slash.pins'),
    usage: '/pins',
    run: () => ({ action: 'pins' })
  },
  {
    name: 'events',
    description: t('slash.events'),
    usage: '/events',
    run: () => ({ action: 'events' })
  },
  {
    name: 'settings',
    description: t('slash.settings'),
    usage: '/settings',
    run: () => ({ action: 'settings' })
  },
  {
    name: 'status',
    description: t('slash.status'),
    usage: '/status <text>',
    run: (rest) => ({ action: 'status', value: rest })
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
