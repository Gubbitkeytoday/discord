// ============================================================================
//  Two-colour profile theme (primary → accent gradient) with a contrast guard.
//
//  The card's text colour is whichever of near-white / near-black reads best
//  on *both* ends of the gradient. When even the better one falls under
//  4.5:1 (mid-tone colours), the content panel gets a stronger scrim so the
//  text is always measured against a known background.
// ============================================================================

import { contrastRatio, parseHex } from '../utils/color';

const LIGHT = '#f8fafc';
const DARK = '#0b0d12';

export const THEME_PRESETS = Object.freeze([
  ['#1e3a8a', '#9333ea'],
  ['#0f766e', '#84cc16'],
  ['#7f1d1d', '#f59e0b'],
  ['#831843', '#f472b6'],
  ['#0c4a6e', '#38bdf8'],
  ['#1f2937', '#6b7280'],
  ['#fde68a', '#fb7185'],
  ['#e0f2fe', '#a78bfa']
]);

export function profileTheme(colors) {
  if (!Array.isArray(colors) || colors.length !== 2 || !colors.every((c) => parseHex(c))) return null;
  const [primary, accent] = colors;
  const minWith = (fg) => Math.min(contrastRatio(fg, primary), contrastRatio(fg, accent));
  const light = minWith(LIGHT);
  const dark = minWith(DARK);
  const useLight = light >= dark;
  const best = Math.max(light, dark);
  // Scrim strength for the inner panel: stronger when the gradient is harsh.
  const scrim = best >= 7 ? 0.28 : best >= 4.5 ? 0.42 : 0.62;
  const panel = useLight
    ? `rgba(11, 13, 18, ${scrim})`
    : `rgba(248, 250, 252, ${scrim + 0.1})`;
  return {
    primary,
    accent,
    fg: useLight ? LIGHT : DARK,
    dark: useLight,
    ratio: Math.round(best * 10) / 10,
    style: {
      backgroundImage: `linear-gradient(180deg, ${primary} 0%, ${primary} 18%, ${accent} 100%)`,
      '--pf-fg': useLight ? LIGHT : DARK,
      '--pf-fg-muted': useLight ? 'rgba(248,250,252,.78)' : 'rgba(11,13,18,.72)',
      '--pf-panel': panel,
      '--pf-divider': useLight ? 'rgba(248,250,252,.18)' : 'rgba(11,13,18,.16)'
    }
  };
}
