import React, { useState } from 'react';
import { Ban } from 'lucide-react';
import CosmeticImage from './CosmeticImage';
import { itemName } from '../../profile/store';
import { proxiedImageUrl } from '../../utils/media';
import { DEFAULT_AVATAR } from '../../utils/avatar';
import { t } from '../../i18n/index.jsx';
import '../../profile/profile.css';

/**
 * A grid of free collectibles of one kind; "None" first. Art is still until
 * a tile is hovered or focused (then it plays, motion permitting).
 *
 * Stable API: <CosmeticPicker kind items value onChange avatarSrc label />
 */
export default function CosmeticPicker({ kind, items = [], value = null, onChange, avatarSrc, label }) {
  const onKeyDown = (e) => {
    const tiles = [...e.currentTarget.querySelectorAll('[data-tile]')];
    const i = tiles.indexOf(document.activeElement);
    const cols = Math.max(1, Math.round(e.currentTarget.clientWidth / (tiles[0]?.offsetWidth || 88)));
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    if (!(e.key in moves) || i < 0) return;
    e.preventDefault();
    const next = tiles[Math.min(tiles.length - 1, Math.max(0, i + moves[e.key]))];
    next?.focus();
    next?.click();
  };
  const all = [{ id: null }, ...items];
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown}
      className={`grid gap-2 ${kind === 'nameplate' ? 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(84px,1fr))]'}`}>
      {all.map((item) => (
        <Tile key={item.id ?? 'none'} kind={kind} item={item.id ? item : null} selected={(value ?? null) === item.id}
          onSelect={() => onChange(item.id)} avatarSrc={avatarSrc} />
      ))}
    </div>
  );
}

function Tile({ kind, item, selected, onSelect, avatarSrc }) {
  const [hover, setHover] = useState(false);
  const name = item ? itemName(item) : t('profiles.none');
  return (
    <button
      type="button"
      role="radio"
      data-tile
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      title={name}
      className={`group flex min-h-11 flex-col items-center gap-1 rounded-lg border p-1.5 text-center transition-colors
        focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand
        ${selected ? 'border-d-brand bg-d-active' : 'border-d-divider bg-d-sunken hover:border-d-text4'}`}
    >
      <span className="relative flex h-[68px] w-full items-center justify-center overflow-hidden rounded-md" aria-hidden="true">
        {!item && <Ban className="h-6 w-6 text-d-text4" />}
        {item && kind === 'avatar_decoration' && (
          <span className="relative block h-[52px] w-[52px]">
            <img src={proxiedImageUrl(avatarSrc) || DEFAULT_AVATAR} alt="" className="h-full w-full rounded-full object-cover" />
            <CosmeticImage item={item} animate={hover} className="absolute max-w-none" style={{ width: 62.4, height: 62.4, left: -5.2, top: -5.2 }} />
          </span>
        )}
        {item && kind === 'profile_effect' && (
          <span className="relative block h-full w-[48px] overflow-hidden rounded bg-d-panel">
            <CosmeticImage item={item} animate={hover} replay={hover ? 1 : 0} className="absolute inset-0 h-full w-full object-cover" />
          </span>
        )}
        {item && kind === 'nameplate' && (
          <span className="block h-9 w-full rounded bg-d-panel bg-cover bg-right" style={{ backgroundImage: `url("${item.asset_url}")` }} />
        )}
        {item && kind === 'profile_frame' && (
          <span className="pf-frame !relative block h-[64px] w-[48px] bg-d-panel" style={{ borderImageSource: `url("${item.asset_url}")`, borderWidth: 8, borderImageWidth: '8px' }} />
        )}
      </span>
      <span className={`line-clamp-1 w-full text-xs ${selected ? 'font-semibold text-d-strong' : 'text-d-text2'}`}>{name}</span>
    </button>
  );
}
