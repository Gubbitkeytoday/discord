// ============================================================================
//  Base theme values the theme engine needs in JavaScript.
//
//  src/index.css is the source of truth; these are copies of the few values
//  JS has to reason about (text tokens for the gradient contrast guard, the
//  frame colour for <meta name="theme-color">). scripts/test-themes-71.mjs
//  parses index.css and fails if any value here drifts from it.
// ============================================================================

export const BASE_THEMES = ['light', 'ash', 'dark', 'onyx'];
export const DARK_THEMES = ['ash', 'dark', 'onyx'];
/** "Sync with computer" choices for each half of the OS switch. */
export const SYSTEM_LIGHT_CHOICES = ['light', 'ash'];
export const SYSTEM_DARK_CHOICES = ['ash', 'dark', 'onyx'];

/** `--base-bg-app` per theme: the window frame, used for the browser's theme-color. */
export const THEME_FRAME = {
  light: '#e3e4e8',
  ash: '#2a2b30',
  dark: '#121214',
  onyx: '#000000'
};

/**
 * Text tokens of the two themes a gradient can sit on (a gradient is either a
 * light or a dark theme, as on Discord). Only text that can appear on a
 * surface is listed; `text-faint` is placeholder/disabled text.
 */
export const GRADIENT_TEXT = {
  dark: {
    'text-strong': '#ffffff',
    'text-default': '#e4e4e7',
    'text-subtle': '#cdced3',
    'text-muted': '#b8b9bf',
    'text-faint': '#adaeb4',
    'text-link': '#94c4fa',
    'text-brand': '#b0b9ff',
    'text-danger': '#ff9893',
    'text-positive': '#78d493',
    'text-warning': '#f3bf52'
  },
  light: {
    'text-strong': '#060607',
    'text-default': '#232428',
    'text-subtle': '#35373d',
    'text-muted': '#45474f',
    'text-faint': '#4c4e56',
    'text-link': '#004c80',
    'text-brand': '#343fae',
    'text-danger': '#951c16',
    'text-positive': '#11552d',
    'text-warning': '#664200'
  }
};

/** Brand fill behind white labels; stays the same on every theme. */
export const BRAND_FILL = '#5865f2';
