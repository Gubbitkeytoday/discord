// Themes (round 4): contrast, validation and injection-safety tests.
//
//  1. Contrast matrix: every base theme (Light, Ash, Dark, Onyx) and its
//     high-contrast variant, every text token × every surface, from the raw
//     values in src/index.css.
//  2. Gradient presets: every preset × every text token × every surface
//     layer × row state (hover / selected) at 96 points along the gradient,
//     composited exactly as the browser does (sRGB source-over), from the CSS
//     variables the engine actually writes — ≥ 4.5:1 everywhere.
//     Plus 300 random custom themes through the contrast guard.
//  3. The JS copies of CSS values (theme-color frames, gradient text tokens,
//     season accents) match index.css; season accents keep white labels at
//     4.5:1.
//  4. Validation: malformed custom themes and imports are rejected (client
//     schema and the server API), and there is no path from theme data or the
//     pre-paint cache to raw CSS.
//  5. Sound pack files are the deterministic render of their definitions.
//  6. Season windows, favicon, and the settings API round trip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startServer, stopServer, api, get } from './testHarness.mjs';
import { contrast, parseHex, over, sampleGradient, averageColour, isHex6 } from '../src/theme/color.js';
import { GRADIENT_PRESETS, PRESET_IDS } from '../src/theme/presets.js';
import {
  buildGradientTheme, gradientCss, LAYERS, OVERLAY, OVERLAY_ALPHA, SCRIM, MIN_TEXT_CONTRAST
} from '../src/theme/gradient.js';
import { GRADIENT_TEXT, THEME_FRAME } from '../src/theme/palettes.js';
import {
  validateCustomTheme, validateCustomThemes, importTheme, exportTheme, isGradientChoice, ThemeError, MAX_CUSTOM_THEMES
} from '../src/theme/schema.js';
import { SEASON_ACCENT, activeSeason, normalizeSeasonConfig, DEFAULT_SEASON_WINDOWS } from '../src/theme/seasonal.js';
import { PACK_NOTES, PACK_EVENTS, renderEvent, encodeWav } from '../src/theme/soundPacks.js';
import { faviconSvg, unreadFromTitle } from '../src/theme/favicon.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const serviceSource = fs.readFileSync(path.join(ROOT, 'services/userSettings.js'), 'utf8');

/** Custom properties of one CSS rule: name → first #rrggbb in its value. */
function rule(selector, prefix = '--base-') {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule ${selector}`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const out = {};
  for (const [, name, value] of body.matchAll(new RegExp(`${prefix}([\\w-]+):\\s*([^;]+);`, 'g'))) {
    const hex = /#[0-9a-fA-F]{6}\b/.exec(value)?.[0];
    if (hex) out[name] = hex.toLowerCase();
  }
  return out;
}

// --- 1. base theme matrix ----------------------------------------------------

const dark = rule(':root');
const light = { ...dark, ...rule(':root[data-theme="light"]') };
const ash = { ...dark, ...rule(':root[data-theme="ash"]') };
const onyx = { ...dark, ...rule(':root[data-theme="onyx"]') };
const hc = rule(':root[data-contrast="high"]');
const hcLight = rule(':root[data-contrast="high"][data-theme="light"]');
const BASES = {
  light, ash, dark, onyx,
  'light+hc': { ...light, ...hc, ...hcLight },
  'ash+hc': { ...ash, ...hc },
  'dark+hc': { ...dark, ...hc },
  'onyx+hc': { ...onyx, ...hc }
};
const SURFACES = ['bg-app', 'bg-sidebar', 'bg-chat', 'bg-surface', 'bg-raised', 'bg-input', 'bg-hover', 'bg-selected', 'bg-panel', 'bg-rowhover', 'bg-floating'];
const TEXT = ['text-strong', 'text-default', 'text-subtle', 'text-muted', 'text-link', 'text-brand', 'text-danger', 'text-positive'];

for (const [name, theme] of Object.entries(BASES)) {
  test(`base ${name}: every text token ≥ 4.5:1 on every surface`, () => {
    const failures = [];
    for (const fg of TEXT) {
      for (const bg of SURFACES) {
        const r = contrast(theme[fg], theme[bg]);
        if (r < 4.5) failures.push(`${fg} on ${bg} = ${r.toFixed(2)}`);
      }
    }
    for (const bg of SURFACES.filter((s) => s !== 'bg-selected')) {
      const r = contrast(theme['text-faint'], theme[bg]);
      if (r < 4.5) failures.push(`text-faint on ${bg} = ${r.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('theme-color frames in JS equal --base-bg-app in index.css', () => {
  for (const [name, theme] of Object.entries({ light, ash, dark, onyx })) {
    assert.equal(THEME_FRAME[name], theme['bg-app'], name);
  }
  const metas = [...html.matchAll(/<meta name="theme-color" content="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toLowerCase());
  assert.deepEqual(metas.sort(), [THEME_FRAME.dark, THEME_FRAME.light].sort(), 'index.html defaults are the Dark/Light frames');
});

// --- 2. gradient presets --------------------------------------------------------

const rgbaOf = (value) => {
  const m = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(value);
  assert.ok(m, `not an rgb()/rgba() value: ${value}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] === undefined ? 1 : Number(m[4]) };
};

/**
 * Independent re-computation from the CSS variables: for every layer the
 * surface is `scrim(α) over gradient`, rows are `overlay(β) over surface`.
 * Returns the failures (should be none).
 */
function auditTheme(theme, built) {
  const text = GRADIENT_TEXT[theme.base];
  const points = [...sampleGradient(theme.stops, 96), averageColour(theme.stops)];
  const overlay = parseHex(built.vars['--tint-overlay']);
  const failures = [];
  let worst = Infinity;
  for (const layer of Object.keys(LAYERS)) {
    const scrim = rgbaOf(built.vars[`--tint-scrim-${layer}`]);
    const flat = parseHex(built.vars[`--tint-bg-${layer}`]);
    const backgrounds = [...points.map((g) => over(g, scrim.rgb, scrim.a)), flat];
    for (const surface of backgrounds) {
      const states = [['surface', surface], ...Object.entries(OVERLAY_ALPHA).map(([s, a]) => [s, over(surface, overlay, a)])];
      for (const [state, bg] of states) {
        for (const [token, hex] of Object.entries(text)) {
          if (token === 'text-faint' && state === 'selected') continue;
          const r = contrast(hex, bg);
          worst = Math.min(worst, r);
          if (r < MIN_TEXT_CONTRAST && failures.length < 5) failures.push(`${layer}/${state} ${token} ${r.toFixed(2)}`);
        }
      }
    }
  }
  return { failures, worst };
}

for (const preset of GRADIENT_PRESETS) {
  test(`preset ${preset.id}: every text token ≥ 4.5:1 at the worst gradient point`, () => {
    const built = buildGradientTheme(preset);
    const { failures, worst } = auditTheme(preset, built);
    assert.deepEqual(failures, [], `${preset.id} worst ${worst.toFixed(2)}`);
    assert.ok(!built.adjusted || built.amount - built.requested < 0.05, 'presets need at most a small guard adjustment');
  });
}

test('the contrast guard makes any custom theme readable (300 random themes)', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const hex = () => `#${Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0')}`;
  for (let i = 0; i < 300; i += 1) {
    const theme = {
      base: rand() < 0.5 ? 'dark' : 'light',
      stops: Array.from({ length: 1 + Math.floor(rand() * 5) }, hex),
      angle: Math.floor(rand() * 361),
      intensity: Math.floor(rand() * 101)
    };
    const { failures, worst } = auditTheme(theme, buildGradientTheme(theme));
    assert.deepEqual(failures, [], `${JSON.stringify(theme)} worst ${worst.toFixed(2)}`);
  }
});

test('gradient text tokens in JS equal the CSS overrides', () => {
  for (const base of ['dark', 'light']) {
    const cssTokens = rule(`:root[data-tint="gradient"][data-theme="${base}"]`, '--color-');
    for (const [token, value] of Object.entries(GRADIENT_TEXT[base])) {
      if (token === 'text-strong') continue; // inherits the base theme's value
      assert.equal(cssTokens[token], value, `${base} ${token}`);
    }
    assert.equal(GRADIENT_TEXT[base]['text-strong'], BASES[base]['text-strong']);
  }
  assert.equal(SCRIM.dark, '#0d0d10');
  assert.equal(OVERLAY.light, '#000000');
});

test('every surface class the gradient paints has a layer, and high contrast / forced colours drop it', () => {
  for (const layer of Object.keys(LAYERS)) {
    assert.match(css, new RegExp(`var\\(--tint-scrim-${layer}\\)`), `layer ${layer} is used in CSS`);
    assert.match(css, new RegExp(`--color-bg-[a-z]+: var\\(--tint-bg-${layer}\\)`), `flat token for ${layer}`);
  }
  assert.match(css, /@media \(forced-colors: active\) \{\s*:root\[data-tint="gradient"\] \* \{ background-image: none !important; \}/);
});

// --- 3. seasons ----------------------------------------------------------------------

test('season accents: in CSS, and white labels stay ≥ 4.5:1 (hover too)', () => {
  for (const [season, accent] of Object.entries(SEASON_ACCENT)) {
    const block = rule(`:root[data-season="${season}"]`, '--season-');
    assert.equal(block.accent, accent, season);
    assert.ok(contrast('#ffffff', accent) >= 4.5, `${season} white on accent ${contrast('#ffffff', accent).toFixed(2)}`);
  }
});

test('season windows: defaults, wrap-around, moon tables, strict admin config', () => {
  const at = (s) => activeSeason(new Date(`${s}T12:00:00`));
  assert.equal(at('2026-04-13'), 'songkran');
  assert.equal(at('2026-10-31'), 'halloween');
  assert.equal(at('2026-12-31'), 'winter');
  assert.equal(at('2027-01-03'), 'winter');
  assert.equal(at('2026-02-18'), 'lunarnewyear');
  assert.equal(at('2026-11-24'), 'loykrathong');
  assert.equal(at('2026-07-01'), null);
  const custom = normalizeSeasonConfig({ halloween: { enabled: false, start: '10-24', end: '10-31' }, songkran: { start: '2026-04-01', end: '2026-04-30' } });
  assert.equal(activeSeason(new Date('2026-10-30T12:00:00'), custom), null, 'disabled by the admin');
  assert.equal(activeSeason(new Date('2026-04-02T12:00:00'), custom), 'songkran');
  for (const bad of [null, [], { easter: { start: '04-01', end: '04-02' } }, { winter: { start: '12-40', end: '01-01' } },
    { winter: { start: '12-01' } }, { halloween: { start: null, end: null } }, { winter: { start: '12-01', end: '01-01', css: 'x' } }]) {
    assert.throws(() => normalizeSeasonConfig(bad), (e) => e.code === 'INVALID_SEASONS', JSON.stringify(bad));
  }
  assert.deepEqual(normalizeSeasonConfig({}), DEFAULT_SEASON_WINDOWS);
});

// --- 4. validation and injection safety -------------------------------------------------

const GOOD = { id: 'abcd1234', name: 'Sunset café', base: 'dark', stops: ['#112233', '#AABBCC'], angle: 90, intensity: 50 };
const BAD_THEMES = [
  ['css in a stop', { ...GOOD, stops: ['red;}body{display:none'] }],
  ['url in a stop', { ...GOOD, stops: ['url(https://evil.example/x.png)'] }],
  ['named colour', { ...GOOD, stops: ['red'] }],
  ['3-digit hex', { ...GOOD, stops: ['#abc'] }],
  ['six stops', { ...GOOD, stops: ['#000000', '#111111', '#222222', '#333333', '#444444', '#555555'] }],
  ['no stops', { ...GOOD, stops: [] }],
  ['angle out of range', { ...GOOD, angle: 400 }],
  ['fractional intensity', { ...GOOD, intensity: 50.5 }],
  ['base', { ...GOOD, base: 'onyx' }],
  ['unknown key', { ...GOOD, css: 'body{}' }],
  ['empty name', { ...GOOD, name: '   ' }],
  ['long name', { ...GOOD, name: 'x'.repeat(33) }],
  ['control char in name', { ...GOOD, name: 'bad‮name' }],
  ['bad id', { ...GOOD, id: '../x' }],
  ['not an object', 'theme']
];

test('client schema accepts a good theme and rejects every malformed one', () => {
  assert.deepEqual(validateCustomTheme(GOOD), { ...GOOD, stops: ['#112233', '#aabbcc'] });
  for (const [why, theme] of BAD_THEMES) {
    assert.throws(() => validateCustomTheme(theme), ThemeError, why);
  }
  assert.throws(() => validateCustomThemes([GOOD, GOOD]), ThemeError, 'duplicate ids');
  assert.throws(() => validateCustomThemes(Array.from({ length: MAX_CUSTOM_THEMES + 1 }, (_, i) => ({ ...GOOD, id: `abcd${i}xyz` }))), ThemeError, 'too many');
  assert.ok(isGradientChoice('tidepool') && isGradientChoice('none') && isGradientChoice('custom:abcd1234'));
  assert.ok(!isGradientChoice('custom:') && !isGradientChoice('linear-gradient(red,blue)') && !isGradientChoice(null));
});

test('import is strict and export round-trips; imports never carry CSS', () => {
  const json = exportTheme(GOOD);
  assert.deepEqual(JSON.parse(json).stops, ['#112233', '#aabbcc']);
  const back = importTheme(json);
  assert.deepEqual(back, { name: GOOD.name, base: 'dark', stops: ['#112233', '#aabbcc'], angle: 90, intensity: 50 });
  const good = JSON.parse(json);
  const cases = {
    IMPORT_EMPTY: ['', '   '],
    IMPORT_JSON: ['{not json', '<style>body{}</style>'],
    IMPORT_TOO_BIG: [JSON.stringify({ ...good, name: 'x', pad: 'y'.repeat(5000) })],
    IMPORT_FORMAT: [JSON.stringify({ ...good, format: 'discord-theme' }), JSON.stringify({ ...good, version: 2 })],
    IMPORT_SHAPE: ['[]', '"x"', JSON.stringify({ ...good, css: 'body{display:none}' }), '{"__proto__":{"polluted":1}}'],
    THEME_STOPS: [JSON.stringify({ ...good, stops: ['#fff;background:url(x)'] })]
  };
  for (const [code, inputs] of Object.entries(cases)) {
    for (const input of inputs) {
      assert.throws(() => importTheme(input), (e) => e instanceof ThemeError && e.code === code, `${code}: ${input.slice(0, 40)}`);
    }
  }
  assert.equal({}.polluted, undefined, 'no prototype pollution');
});

test('engine output is built from numbers and hex only — no path to raw CSS', () => {
  const SAFE = /^(#[0-9a-f]{6}|rgba?\([\d., ]+\)|linear-gradient\(\d{1,3}deg(, #[0-9a-f]{6})+\))$/;
  for (const theme of [...GRADIENT_PRESETS, { ...GOOD, stops: ['#112233'] }]) {
    for (const [name, value] of Object.entries(buildGradientTheme(theme).vars)) {
      assert.match(name, /^--tint-[a-z-]+$/);
      assert.match(value, SAFE, `${name}: ${value}`);
    }
  }
  // Even if unvalidated data reached gradientCss, non-hex stops are dropped.
  assert.equal(gradientCss({ angle: 'x', stops: ['#112233', 'red;}*{x:y', 'url(a)'] }), 'linear-gradient(180deg, #112233, #112233)');
  const svg = faviconSvg({ stops: ['"/><script>alert(1)</script>', '#ff0000'], angle: 45 }, 3);
  assert.ok(!svg.includes('<script') && svg.includes('#ff0000') && svg.includes('#f23f43'));
  assert.equal(unreadFromTitle('(12) Antigravity'), 12);
  assert.equal(unreadFromTitle('● Kira'), 1);
  assert.equal(unreadFromTitle('Antigravity'), 0);
});

test('the pre-paint script only copies whitelisted, plain values', () => {
  const script = /<script>(\(function\(\)\{try\{var raw=localStorage[\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'inline pre-paint script present');
  const run = (boot) => {
    const dataset = {};
    const props = {};
    const metas = [{ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }];
    const context = {
      localStorage: { getItem: () => (typeof boot === 'string' ? boot : JSON.stringify(boot)) },
      document: {
        documentElement: { dataset, style: { setProperty: (k, v) => { props[k] = v; } } },
        querySelectorAll: () => metas
      }
    };
    vm.runInNewContext(script, context);
    return { dataset, props, meta: metas[0].attrs.content };
  };
  const ok = run({ d: { theme: 'ash', tint: 'gradient' }, v: { '--tint-gradient': 'linear-gradient(160deg, #0f3b4a, #155e63)', '--tint-scrim-chat': 'rgba(13, 13, 16, 0.44)' }, c: '#2a2b30' });
  assert.deepEqual(ok.dataset, { theme: 'ash', tint: 'gradient' });
  assert.equal(ok.props['--tint-scrim-chat'], 'rgba(13, 13, 16, 0.44)');
  assert.equal(ok.meta, '#2a2b30');
  const evil = run({
    d: { theme: 'x" onload="alert(1)', contrast: 'high;}', onclick: 'alert(1)', tint: 'a'.repeat(40) },
    v: {
      '--tint-gradient': 'url(https://evil.example/)',
      '--x': 'image-set("a.png" 1x)',
      '--y': 'red;} body{display:none',
      'background': 'red',
      '--z': 'expression(alert(1))'
    },
    c: 'red;}'
  });
  assert.deepEqual(evil.dataset, {});
  assert.deepEqual(evil.props, {});
  assert.equal(evil.meta, undefined);
  assert.doesNotThrow(() => run('{broken json'));
});

test('server keeps the same preset list and theme limits as the client', () => {
  const ids = /GRADIENT_PRESET_IDS = \[([\s\S]*?)\]/.exec(serviceSource)[1].match(/'([a-z-]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(ids, PRESET_IDS);
  assert.match(serviceSource, new RegExp(`MAX_CUSTOM_THEMES = ${MAX_CUSTOM_THEMES}\\b`));
});

// --- 5. sound packs --------------------------------------------------------------------

test('sound pack files are the render of their definitions (node src/theme/build-sounds.mjs)', () => {
  let total = 0;
  for (const pack of Object.keys(PACK_NOTES)) {
    for (const event of PACK_EVENTS) {
      const file = path.join(ROOT, 'public/sounds', pack, `${event}.wav`);
      assert.ok(fs.existsSync(file), `${pack}/${event}.wav exists`);
      const onDisk = fs.readFileSync(file);
      const fresh = encodeWav(renderEvent(pack, event));
      assert.equal(onDisk.length, fresh.length, `${pack}/${event} length`);
      assert.equal(onDisk.subarray(0, 44).toString('hex'), Buffer.from(fresh.subarray(0, 44)).toString('hex'), 'WAV header');
      for (let i = 44; i < fresh.length; i += 2) {
        const a = onDisk.readInt16LE(i);
        const b = Buffer.from(fresh.buffer).readInt16LE(i);
        if (Math.abs(a - b) > 1) assert.fail(`${pack}/${event} differs at byte ${i}`);
      }
      assert.ok(onDisk.length < 32 * 1024, `${pack}/${event} is small`);
      total += onDisk.length;
    }
  }
  assert.ok(total < 300 * 1024, `all packs together ${total} bytes`);
});

// --- 6. settings API ----------------------------------------------------------------------

before(startServer);
after(stopServer);

test('API: appearance accepts presets, custom themes and the new keys', async () => {
  const theme = { ...GOOD };
  let res = await api('PATCH', '/api/settings/preferences/appearance', {
    customThemes: [theme], gradient: 'custom:abcd1234', uiFont: 'atkinson', radius: 'round', seasonal: 'off',
    soundPack: 'glass', chatLineHeight: 1.5, letterSpacing: 0.12, wordSpacing: 0.16, systemLightTheme: 'ash', chatFontScale: 150
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.customThemes, [{ ...theme, stops: ['#112233', '#aabbcc'] }]);
  assert.equal(res.body.gradient, 'custom:abcd1234');
  res = await api('PATCH', '/api/settings/preferences/appearance', { gradient: 'glacier', chatFontScale: 400 });
  assert.equal(res.status, 200);
  assert.equal(res.body.chatFontScale, 150, 'clamped to 24 px');
  const { body } = await get('/api/settings/preferences');
  assert.equal(body.appearance.gradient, 'glacier');
  assert.equal(body.appearance.soundPack, 'glass');
});

test('API: malformed custom themes and unknown choices are rejected (400) and nothing is stored', async () => {
  for (const [why, theme] of BAD_THEMES) {
    const res = await api('PATCH', '/api/settings/preferences/appearance', { customThemes: [theme] });
    assert.equal(res.status, 400, `${why}: ${JSON.stringify(res.body)}`);
  }
  const tooMany = Array.from({ length: MAX_CUSTOM_THEMES + 1 }, (_, i) => ({ ...GOOD, id: `abcd${i}xyz` }));
  for (const patch of [
    { customThemes: tooMany },
    { customThemes: 'x' },
    { customThemes: [GOOD, GOOD] },
    { gradient: 'custom:zzzz9999' },
    { gradient: 'linear-gradient(red, blue)' },
    { uiFont: 'comic-sans' },
    { radius: '50%' },
    { soundPack: '../../etc/passwd' },
    { seasonal: 'always' },
    { systemDarkTheme: 'light' },
    { letterSpacing: 'wide' }
  ]) {
    const res = await api('PATCH', '/api/settings/preferences/appearance', patch);
    assert.equal(res.status, 400, JSON.stringify(patch).slice(0, 80));
  }
  const { body } = await get('/api/settings/preferences');
  assert.equal(body.appearance.gradient, 'glacier', 'the last good value is kept');
  assert.equal(body.appearance.customThemes.length, 1);
});

test('API: deleting the selected custom theme must also move the selection', async () => {
  let res = await api('PATCH', '/api/settings/preferences/appearance', { gradient: 'custom:abcd1234' });
  assert.equal(res.status, 200);
  res = await api('PATCH', '/api/settings/preferences/appearance', { customThemes: [] });
  assert.equal(res.status, 400, 'a dangling custom: selection is refused');
  res = await api('PATCH', '/api/settings/preferences/appearance', { customThemes: [], gradient: 'none' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.customThemes, []);
});

test('every seasonal window default is valid admin config', () => {
  assert.doesNotThrow(() => normalizeSeasonConfig(DEFAULT_SEASON_WINDOWS));
  assert.ok(isHex6(SEASON_ACCENT.winter));
});

test('production CSP allows exactly the pre-paint inline script by hash', async () => {
  const crypto = await import('node:crypto');
  const fs = await import('node:fs');
  const { inlineScriptHashes, securityHeaders } = await import('../lib/middleware.js');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const body = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const expected = `'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`;
  assert.ok(inlineScriptHashes().includes(expected));
  let csp = '';
  securityHeaders({ isProduction: true })({ path: '/' }, { setHeader: (k, v) => { if (k === 'Content-Security-Policy') csp = v; }, removeHeader() {} }, () => {});
  const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src'));
  assert.ok(scriptSrc.includes(expected));
  assert.ok(!scriptSrc.includes('unsafe-inline'));
});
