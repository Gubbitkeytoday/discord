// Recently used emoji (shared by the picker and the quick-reaction bar).
// Stored per browser, like Discord's "Frequently used", newest first.

const RECENT_KEY = 'antigravity.recentEmojis';
const RECENT_LIMIT = 24;

export const DEFAULT_QUICK_REACTIONS = ['❤️', '🔥', '👍', '😂', '🎉', '🚀', '💯', '🙏', '✨'];

export function loadRecentEmoji() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.slice(0, RECENT_LIMIT) : [];
  } catch { return []; }
}

/** Remember an entry: { char } for unicode, { id, name, url, custom } for server emoji. */
export function saveRecentEmoji(entry) {
  if (!entry) return;
  try {
    const key = JSON.stringify(entry);
    const current = loadRecentEmoji().filter((e) => JSON.stringify(e) !== key);
    localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...current].slice(0, RECENT_LIMIT)));
  } catch { /* private mode — recents simply do not persist */ }
}

/** The quick reactions to offer: your recent unicode emoji first, then defaults. */
export function quickReactions(count = 3) {
  const out = [];
  for (const entry of loadRecentEmoji()) {
    if (entry?.char && !out.includes(entry.char)) out.push(entry.char);
    if (out.length >= count) return out;
  }
  for (const char of DEFAULT_QUICK_REACTIONS) {
    if (!out.includes(char)) out.push(char);
    if (out.length >= count) break;
  }
  return out;
}
