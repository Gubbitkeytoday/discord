// ============================================================================
//  Seasonal themes: a subtle accent and one small decoration, on by default
//  during a season's window, off with one switch (Appearance › Seasonal
//  themes). Never changes surfaces or text, so contrast is untouched; the
//  decoration is static under reduced motion.
//
//  The art and the accent live in index.css (`:root[data-season=…]`); this
//  module only decides WHICH season is active. Windows are data an instance
//  admin can override (normalizeSeasonConfig validates what they send).
// ============================================================================

export const SEASONS = ['songkran', 'loykrathong', 'lunarnewyear', 'halloween', 'winter'];

/**
 * Accent per season — the brand fill while it is active. Each one keeps
 * white button labels at 4.5:1 or better (checked by the test suite).
 */
export const SEASON_ACCENT = {
  songkran: '#0a6aa1',
  loykrathong: '#8a5300',
  lunarnewyear: '#b8232b',
  halloween: '#a94400',
  winter: '#2a64a8'
};

// Moon-dated festivals move every year. Loy Krathong is the full moon of the
// 12th Thai lunar month; Lunar New Year is the second new moon after the
// winter solstice. Defaults for the years we know; an admin can set any year.
const LOY_KRATHONG = {
  2025: '11-05', 2026: '11-24', 2027: '11-13', 2028: '11-02', 2029: '11-21', 2030: '11-10'
};
const LUNAR_NEW_YEAR = {
  2025: '01-29', 2026: '02-17', 2027: '02-06', 2028: '01-26', 2029: '02-13', 2030: '02-03'
};

/** Default windows: 'MM-DD' repeats yearly; a window may wrap the new year. */
export const DEFAULT_SEASON_WINDOWS = {
  songkran: { enabled: true, start: '04-10', end: '04-17' },
  loykrathong: { enabled: true, start: null, end: null },   // from the table
  lunarnewyear: { enabled: true, start: null, end: null },  // from the table
  halloween: { enabled: true, start: '10-24', end: '10-31' },
  winter: { enabled: true, start: '12-15', end: '01-05' }
};

const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const YMD = /^(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function shiftDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  return dayKey(date);
}

/** Concrete [start, end] 'YYYY-MM-DD' ranges a window covers around `year`. */
function rangesFor(id, window, year) {
  if (!window?.enabled) return [];
  const { start, end } = window;
  if (start && end) {
    if (YMD.test(start) && YMD.test(end)) return [[start, end]];
    if (MMDD.test(start) && MMDD.test(end)) {
      // A wrapping window (Dec → Jan) is the one starting last year or this year.
      if (start <= end) return [[`${year}-${start}`, `${year}-${end}`]];
      return [[`${year - 1}-${start}`, `${year}-${end}`], [`${year}-${start}`, `${year + 1}-${end}`]];
    }
    return [];
  }
  const table = id === 'loykrathong' ? LOY_KRATHONG : id === 'lunarnewyear' ? LUNAR_NEW_YEAR : null;
  const day = table?.[year];
  if (!day) return [];
  const center = `${year}-${day}`;
  return id === 'loykrathong'
    ? [[shiftDays(center, -3), shiftDays(center, 1)]]
    : [[shiftDays(center, -2), shiftDays(center, 7)]];
}

/** Which season (if any) is on at `date`, given the instance's windows. */
export function activeSeason(date = new Date(), config = DEFAULT_SEASON_WINDOWS) {
  const today = dayKey(date);
  const year = date.getFullYear();
  for (const id of SEASONS) {
    const window = config?.[id] ?? DEFAULT_SEASON_WINDOWS[id];
    if (rangesFor(id, window, year).some(([s, e]) => s <= today && today <= e)) return id;
  }
  return null;
}

/** The dates a season covers this year, for the settings page ('' = none). */
export function seasonDates(id, date = new Date(), config = DEFAULT_SEASON_WINDOWS) {
  const ranges = rangesFor(id, config?.[id] ?? DEFAULT_SEASON_WINDOWS[id], date.getFullYear());
  const current = ranges.find(([, e]) => e >= dayKey(date)) ?? ranges[0];
  return current ? { start: current[0], end: current[1] } : null;
}

/**
 * Validate an admin's seasonal configuration. Strict: known season ids only,
 * `enabled` boolean, start/end both 'MM-DD' or both 'YYYY-MM-DD' (or both
 * null for the built-in moon tables). Throws Error with code INVALID_SEASONS.
 */
export function normalizeSeasonConfig(input) {
  const fail = (why) => Object.assign(new Error(`Invalid seasonal windows: ${why}`), { code: 'INVALID_SEASONS' });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('not an object');
  const out = {};
  for (const [id, window] of Object.entries(input)) {
    if (!SEASONS.includes(id)) throw fail(`unknown season ${id}`);
    if (!window || typeof window !== 'object' || Array.isArray(window)) throw fail(id);
    for (const key of Object.keys(window)) {
      if (!['enabled', 'start', 'end'].includes(key)) throw fail(`${id}.${key}`);
    }
    const enabled = window.enabled !== false;
    const start = window.start ?? null;
    const end = window.end ?? null;
    const bothNull = start === null && end === null;
    const bothMonthDay = MMDD.test(String(start)) && MMDD.test(String(end));
    const bothDates = YMD.test(String(start)) && YMD.test(String(end)) && start <= end;
    if (!bothNull && !bothMonthDay && !bothDates) throw fail(`${id} dates`);
    if (bothNull && !['loykrathong', 'lunarnewyear'].includes(id)) throw fail(`${id} needs dates`);
    out[id] = { enabled, start, end };
  }
  return { ...DEFAULT_SEASON_WINDOWS, ...out };
}

// --- instance configuration ---------------------------------------------------

let instanceWindows = DEFAULT_SEASON_WINDOWS;
const seasonListeners = new Set();

/** Set the instance admin's windows (from the server's public config). */
export function configureSeasonWindows(config) {
  try {
    instanceWindows = config ? normalizeSeasonConfig(config) : DEFAULT_SEASON_WINDOWS;
  } catch {
    instanceWindows = DEFAULT_SEASON_WINDOWS;
  }
  for (const fn of seasonListeners) fn();
}

export function getSeasonWindows() {
  return instanceWindows;
}

export function onSeasonWindowsChange(fn) {
  seasonListeners.add(fn);
  return () => seasonListeners.delete(fn);
}

/**
 * The season to show for a user: `seasonal` is 'auto' (default) or 'off';
 * `preview` (settings page "Try it") wins for this session only.
 */
export function resolveSeason({ seasonal = 'auto', preview = null } = {}, date = new Date()) {
  if (preview && SEASONS.includes(preview)) return preview;
  if (seasonal === 'off') return null;
  return activeSeason(date, instanceWindows);
}
