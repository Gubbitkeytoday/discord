import React from 'react';
import { Play } from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import { SOUND_PACKS } from '../../theme/soundPacks.js';
import { previewSoundPack } from '../../utils/soundEffects';
import { useRovingRadio } from './useRovingRadio.js';

/**
 * Notification sound packs. Each row: a radio for the pack and a separate
 * preview button (a button cannot sit inside a radio). Preview plays a
 * message then a mention, whatever pack is selected.
 */
export default function SoundPackPicker({ value, onChange }) {
  const selected = SOUND_PACKS.includes(value) ? value : 'classic';
  const itemProps = useRovingRadio(SOUND_PACKS, selected, onChange);
  const preview = (pack) => {
    previewSoundPack(pack, 'message');
    setTimeout(() => previewSoundPack(pack, 'mention'), 550);
  };

  return (
    <div role="radiogroup" aria-label={t('theme.soundPack')} className="space-y-2">
      {SOUND_PACKS.map((pack) => {
        const isOn = pack === selected;
        return (
          <div
            key={pack}
            className={`flex items-center gap-2 rounded-lg border pr-2 transition-colors
              ${isOn ? 'border-d-brand bg-d-brand/10' : 'border-d-divider bg-d-surface'}`}
          >
            <button
              type="button"
              {...itemProps(pack)}
              className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left"
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2
                  ${isOn ? 'border-d-brand' : 'border-d-control'}`}
              >
                {isOn && <span className="h-2.5 w-2.5 rounded-full bg-d-brand" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-d-strong">{t(`theme.pack.${pack}`)}</span>
                <span className="mt-0.5 block text-xs text-d-text2">{t(`theme.pack.${pack}Hint`)}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => preview(pack)}
              aria-label={t('theme.previewPack', { name: t(`theme.pack.${pack}`) })}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-d-control2 text-d-strong hover:bg-d-control"
            >
              <Play className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
