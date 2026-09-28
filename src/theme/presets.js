// ============================================================================
//  Gradient theme presets — free for everyone.
//
//  Names and colours are our own (docs/research/DISCORD-THEMES.md §4.2), not
//  Discord's. Each preset is a light or a dark theme: the text keeps that
//  base theme's tokens and the gradient is shown through a scrim that the
//  contrast guard (gradient.js) makes thick enough for 4.5:1 everywhere.
//
//  services/userSettings.js keeps its own copy of the ids (the server does not
//  ship src/); the test suite checks the two lists match.
// ============================================================================

export const GRADIENT_PRESETS = [
  { id: 'tidepool',      base: 'dark',  angle: 160, stops: ['#0f3b4a', '#155e63', '#1d4e6e'] },
  { id: 'ember-dusk',    base: 'dark',  angle: 145, stops: ['#4a1d2f', '#7a2e2a', '#3a1f4d'] },
  { id: 'deep-orchard',  base: 'dark',  angle: 170, stops: ['#16311f', '#2f4a2a', '#4a4a24'] },
  { id: 'ultraviolet',   base: 'dark',  angle: 135, stops: ['#241a5c', '#4b1f73', '#16254f'] },
  { id: 'night-market',  base: 'dark',  angle: 120, stops: ['#0b3a3a', '#3d2466', '#6a1f4f'] },
  { id: 'graphite-rose', base: 'dark',  angle: 180, stops: ['#2a2427', '#4a2e38'] },
  { id: 'monsoon',       base: 'dark',  angle: 155, stops: ['#1f2f45', '#2e3f5c', '#35506a'] },
  { id: 'peach-soda',    base: 'light', angle: 160, stops: ['#ffd3b6', '#ffb5a7', '#f9c6d9'] },
  { id: 'matcha-milk',   base: 'light', angle: 170, stops: ['#d8ecc6', '#c7e3d4', '#e6edc0'] },
  { id: 'paper-lantern', base: 'light', angle: 150, stops: ['#f6e7c1', '#f3d2a6', '#ecd9e6'] },
  { id: 'glacier',       base: 'light', angle: 180, stops: ['#cfe6f7', '#d9ddfb', '#e3f3f1'] },
  { id: 'lilac-hour',    base: 'light', angle: 140, stops: ['#e2d4fb', '#f6d2ea', '#d4dcfb'] }
].map((preset) => Object.freeze({ intensity: 70, ...preset }));

export const PRESET_IDS = GRADIENT_PRESETS.map((p) => p.id);

export function findPreset(id) {
  return GRADIENT_PRESETS.find((p) => p.id === id) ?? null;
}
