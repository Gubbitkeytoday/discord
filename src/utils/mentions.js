// ============================================================================
//  Composer tokens.
//
//  The composer shows what people typed — `@alice`, `#general`, `:party:` —
//  and the wire format is Discord's tokens: `<@id>`, `<#id>`, `<:name:id>`.
//  The server only notifies for tokens, so a typed `@alice` used to be plain
//  text: no ping, no highlight. `resolveComposerTokens` converts on send,
//  the way Discord's client does. Code spans and blocks are left alone.
// ============================================================================

const USER = /(^|[\s(>*_~|])@([\p{L}\p{M}\p{N}_.-]+)/gu;
const CHANNEL = /(^|[\s(>*_~|])#([\p{L}\p{M}\p{N}_-]+)/gu;
const EMOJI = /(^|[^<\w]):([\w-]{2,32}):(?!\d)/g;

const lower = (s) => String(s ?? '').toLowerCase();

function findMember(members, handle) {
  const h = lower(handle);
  return members.find((m) => lower(m.username) === h)
    ?? members.find((m) => lower(m.display_name) === h && !/\s/.test(m.display_name ?? ''));
}

/** Try the handle, then without trailing punctuation ("@bob." → "bob"). */
function matchWithTrailing(handle, lookup) {
  const hit = lookup(handle);
  if (hit) return { hit, rest: '' };
  const trimmed = handle.replace(/[.\-_]+$/, '');
  if (trimmed && trimmed !== handle) {
    const again = lookup(trimmed);
    if (again) return { hit: again, rest: handle.slice(trimmed.length) };
  }
  return null;
}

function resolvePlain(text, { members, channels, customEmojis }) {
  let out = text.replace(USER, (whole, lead, handle) => {
    if (handle === 'everyone' || handle === 'here') return whole;
    const found = matchWithTrailing(handle, (h) => findMember(members, h));
    return found ? `${lead}<@${found.hit.id}>${found.rest}` : whole;
  });
  out = out.replace(CHANNEL, (whole, lead, name) => {
    const found = matchWithTrailing(name, (n) => channels.find((c) => c.type !== 'category' && lower(c.name) === lower(n)));
    return found ? `${lead}<#${found.hit.id}>${found.rest}` : whole;
  });
  out = out.replace(EMOJI, (whole, lead, name) => {
    const emoji = customEmojis.find((e) => e.name === name) ?? customEmojis.find((e) => lower(e.name) === lower(name));
    return emoji ? `${lead}<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>` : whole;
  });
  return out;
}

export function resolveComposerTokens(text, { members = [], channels = [], customEmojis = [] } = {}) {
  if (!text) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) => (index % 2 === 1 ? part : resolvePlain(part, { members, channels, customEmojis })))
    .join('');
}

/**
 * The reverse, for editing a sent message: show `@alice` rather than
 * `<@1553…>` in the edit box. Unknown ids stay as tokens so nothing is lost.
 */
export function humanizeTokens(text, { members = [], channels = [] } = {}) {
  if (!text) return text;
  return text
    .replace(/<@!?([\w-]+)>/g, (whole, id) => {
      const m = members.find((x) => String(x.id) === id);
      return m?.username ? `@${m.username}` : whole;
    })
    .replace(/<#([\w-]+)>/g, (whole, id) => {
      const c = channels.find((x) => String(x.id) === id);
      return c?.name && /^[\p{L}\p{M}\p{N}_-]+$/u.test(c.name) ? `#${c.name}` : whole;
    });
}

/** Does this message ping `user` (directly, via a role, @everyone/@here, or a reply)? */
export function mentionsUser(message, user, { roleIds = [], repliedToUserId = null } = {}) {
  if (!message || !user || message.user_id === user.id) return false;
  const content = message.content ?? '';
  if (content.includes(`<@${user.id}>`) || content.includes(`<@!${user.id}>`)) return true;
  // The server sets mention_everyone only when the author may use it.
  if (message.mention_everyone) return true;
  if (roleIds.some((id) => content.includes(`<@&${id}>`))) return true;
  if (repliedToUserId && repliedToUserId === user.id) return true;
  return false;
}
