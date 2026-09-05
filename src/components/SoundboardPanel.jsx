// ============================================================================
//  Soundboard.
//
//  The clip is not mixed into anyone's microphone. The sender asks the gateway
//  to broadcast "play this sound"; every client in the room plays it locally.
//  That keeps the effect at full fidelity — a voice track is compressed and
//  noise-gated, which is precisely wrong for a sound effect — and costs the
//  sender no extra upstream, which is the scarce resource in a full-mesh call.
//
//  The visible consequence: you hear your own clip immediately, because the
//  broadcast comes back to you like everyone else.
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Music, Loader2, X } from 'lucide-react';
import { get } from '../api';
import { t } from '../i18n/index.jsx';

export default function SoundboardPanel({ serverId, channelId, socket, onClose, onToast }) {
  const [sounds, setSounds] = useState(null);   // null = still loading
  const [cooling, setCooling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!serverId) { setSounds([]); return undefined; }
    get(`/api/servers/${serverId}/sounds`)
      .then((list) => { if (!cancelled) setSounds(Array.isArray(list) ? list : []); })
      .catch((err) => { if (!cancelled) { setSounds([]); onToast?.(err.message, { type: 'error' }); } });
    return () => { cancelled = true; };
  }, [serverId, onToast]);

  const play = (sound) => {
    if (cooling) return;
    socket?.emit('play_sound', { channelId, soundId: sound.id });
    // Mirror the server's own cooldown so the button reads as unavailable
    // instead of silently doing nothing.
    setCooling(true);
    setTimeout(() => setCooling(false), 1500);
  };

  return (
    <div
      // A popover, not a modal: it does not trap focus and the call keeps
      // running behind it. Announcing it as modal would tell a screen reader
      // the rest of the app is inert, which would be untrue.
      role="group"
      aria-label={t('soundboard.title')}
      className="absolute bottom-full left-1/2 z-20 mb-3 w-[340px] -translate-x-1/2 rounded-xl
        border border-d-divider bg-d-panel p-3 shadow-2xl"
    >
      <header className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-d-text2">
          <Music className="h-3.5 w-3.5" aria-hidden="true" /> {t('soundboard.title')}
        </h3>
        <button
          onClick={onClose}
          aria-label={t('common.close')}
          className="rounded p-1 text-d-text3 hover:bg-d-hover hover:text-d-strong"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {sounds === null && (
        <div className="flex items-center justify-center py-8 text-d-text3">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}

      {sounds?.length === 0 && (
        <p className="px-1 py-6 text-center text-sm text-d-text3">{t('soundboard.empty')}</p>
      )}

      {sounds?.length > 0 && (
        <div className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto">
          {sounds.map((sound) => (
            <button
              key={sound.id}
              onClick={() => play(sound)}
              disabled={cooling}
              title={sound.name}
              className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg
                border border-d-divider bg-d-surface p-2 transition-colors hover:border-d-brand
                hover:bg-d-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="text-2xl leading-none" aria-hidden="true">{sound.emoji || '🔊'}</span>
              <span className="w-full truncate text-center text-[11px] text-d-text2">{sound.name}</span>
            </button>
          ))}
        </div>
      )}

      <p className="mt-2 px-1 text-[11px] text-d-text4">{t('soundboard.hint')}</p>
    </div>
  );
}
