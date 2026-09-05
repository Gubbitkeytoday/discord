// ============================================================================
//  Search operators — `from:mai has:link before:2026-01-01 deploy failed`
//
//  Discord's search box is a small query language, and people lean on it
//  heavily: `from:` to find who said it, `in:` to narrow the room, `has:` for
//  attachments and links, and the date trio to bound the window.
//
//  This module is deliberately pure — no database, no permissions, no async.
//  It turns a raw string into `{ term, filters, unknown }` and nothing else,
//  which makes every edge case (a colon inside a word, a quoted phrase, an
//  operator with an empty value) testable without a server.
//
//  Resolution of names to ids ("mai" → user-2, "#general" → chan-102) belongs
//  to the service, because that needs the viewer's context to be safe.
// ============================================================================

// Everything we accept. An unrecognised `word:` is left in the search text —
// Discord does the same, so a message containing "http://" still finds itself.
const OPERATORS = new Set([
  'from', 'mentions', 'in', 'has', 'before', 'after', 'during', 'pinned'
]);

// `has:` is a closed set; anything else is not an operator use at all.
const HAS_VALUES = new Set(['link', 'embed', 'file', 'attachment', 'image', 'video', 'sound', 'poll', 'sticker']);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const YEAR = /^\d{4}$/;

/** ISO bounds for a `during:` value, which may be a day, a month or a year. */
export function periodBounds(value) {
  if (DATE.test(value)) return { from: `${value}T00:00:00.000Z`, to: `${value}T23:59:59.999Z` };
  if (MONTH.test(value)) {
    const [y, m] = value.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 1) - 1);
    return { from: `${value}-01T00:00:00.000Z`, to: end.toISOString() };
  }
  if (YEAR.test(value)) return { from: `${value}-01-01T00:00:00.000Z`, to: `${value}-12-31T23:59:59.999Z` };
  return null;
}

/**
 * Split a raw query into tokens, honouring double quotes so that
 * `from:"Mai Suwan"` and `"deploy failed"` both survive as one piece.
 */
function tokenize(raw) {
  const tokens = [];
  let current = '';
  let quoted = false;
  for (const char of raw) {
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && /\s/.test(char)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Parse a search box string.
 *
 * Returns:
 *   term     — the free text left after the operators are removed
 *   filters  — { from[], mentions[], in[], has[], before, after, during, pinned }
 *              name-valued filters stay as the raw strings the user typed;
 *              the caller resolves them.
 *   unknown  — operator-looking tokens we did not accept, so the UI can say so.
 */
export function parseSearchQuery(raw) {
  const filters = { from: [], mentions: [], in: [], has: [], before: null, after: null, during: null, pinned: null };
  const unknown = [];
  const words = [];

  for (const token of tokenize(String(raw ?? ''))) {
    const colon = token.indexOf(':');
    // A leading colon (":)" emoticon) or a trailing one is text, not a filter.
    if (colon <= 0 || colon === token.length - 1) { words.push(token); continue; }

    const key = token.slice(0, colon).toLowerCase();
    const value = token.slice(colon + 1);
    if (!OPERATORS.has(key)) { words.push(token); continue; }

    switch (key) {
      case 'from':
      case 'mentions':
        // `@mai` and `mai` mean the same thing.
        filters[key].push(value.replace(/^@/, ''));
        break;
      case 'in':
        filters.in.push(value.replace(/^#/, ''));
        break;
      case 'has':
        if (HAS_VALUES.has(value.toLowerCase())) filters.has.push(value.toLowerCase());
        else { unknown.push(token); words.push(token); }
        break;
      case 'pinned':
        filters.pinned = value.toLowerCase() === 'true';
        break;
      case 'before':
      case 'after':
        if (DATE.test(value)) filters[key] = value;
        else { unknown.push(token); words.push(token); }
        break;
      case 'during':
        if (periodBounds(value)) filters.during = value;
        else { unknown.push(token); words.push(token); }
        break;
      default:
        words.push(token);
    }
  }

  return { term: words.join(' ').trim(), filters, unknown };
}

/** True when the parsed query narrows anything at all. */
export function hasFilters(filters) {
  return filters.from.length > 0 || filters.mentions.length > 0 || filters.in.length > 0
    || filters.has.length > 0 || Boolean(filters.before || filters.after || filters.during)
    || filters.pinned !== null;
}
