// Icons for badges and server tags: lucide glyphs plus two original Thai
// motifs (lotus, elephant) drawn in the same 24px stroke style.

import React from 'react';
import {
  Leaf, Star, Heart, Zap, Flame, Moon, Sun, Gem, Music, Gamepad2, Sword, Flower2, PawPrint, Coffee,
  Rocket, Cloud, Snowflake, Anchor, Code, BookOpen, Trophy, Medal, Palette, Camera, Mic, Handshake,
  ShieldCheck, Bot, Sparkles, MailCheck, Sprout, HandHeart
} from 'lucide-react';

function Lotus({ className = '', ...rest }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" className={className} aria-hidden="true" {...rest}>
      <path d="M12 4c2.5 2.5 2.5 7 0 11-2.5-4-2.5-8.5 0-11Z" />
      <path d="M12 15c-1-3.5-4-6-8-6.5 .5 4 3.5 6.5 8 6.5Z" />
      <path d="M12 15c1-3.5 4-6 8-6.5-.5 4-3.5 6.5-8 6.5Z" />
      <path d="M4 19h16" />
    </svg>
  );
}

function Elephant({ className = '', ...rest }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" className={className} aria-hidden="true" {...rest}>
      <path d="M3 17v-5a6 6 0 0 1 6-6h4a5 5 0 0 1 5 5v1.5c0 1.5 1 2.5 2.5 2.5" />
      <path d="M20.5 15V19" />
      <path d="M6 17v3M10 17v3M15 17v3" />
      <path d="M3 17h13" />
      <path d="M13 6a3 3 0 0 1 0 6" />
      <circle cx="16" cy="9" r=".6" fill="currentColor" />
    </svg>
  );
}

export const GLYPHS = Object.freeze({
  leaf: Leaf, star: Star, heart: Heart, bolt: Zap, flame: Flame, moon: Moon, sun: Sun, gem: Gem,
  music: Music, gamepad: Gamepad2, sword: Sword, flower: Flower2, lotus: Lotus, elephant: Elephant,
  paw: PawPrint, coffee: Coffee, rocket: Rocket, cloud: Cloud, snowflake: Snowflake, anchor: Anchor,
  code: Code, book: BookOpen, trophy: Trophy, medal: Medal, palette: Palette, camera: Camera, mic: Mic,
  handshake: Handshake,
  // System badges only — never offered to servers.
  shield: ShieldCheck, bot: Bot, sparkles: Sparkles, mail: MailCheck, sprout: Sprout, supporter: HandHeart
});

export const TAG_ICONS = [
  'leaf', 'star', 'heart', 'bolt', 'flame', 'moon', 'sun', 'gem', 'music', 'gamepad', 'sword',
  'flower', 'lotus', 'elephant', 'paw', 'coffee', 'rocket', 'cloud', 'snowflake', 'anchor', 'code', 'book'
];
export const BADGE_ICONS = [
  'star', 'trophy', 'heart', 'bolt', 'flame', 'gem', 'music', 'gamepad', 'book', 'code', 'leaf',
  'flower', 'lotus', 'elephant', 'rocket', 'medal', 'palette', 'camera', 'mic', 'handshake'
];

export function Glyph({ name, className = 'h-4 w-4', ...rest }) {
  const Icon = GLYPHS[name] ?? Star;
  return <Icon className={className} aria-hidden="true" {...rest} />;
}
