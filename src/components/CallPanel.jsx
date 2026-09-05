// ============================================================================
//  Calls in DMs — the ring and the in-call bar.
//
//  Two surfaces, one state:
//    * IncomingCall — a floating card that appears wherever the user happens to
//      be in the app, because a call that only rings in the conversation you
//      already have open is not a call.
//    * CallBar — a strip above the composer while a call is live, with the
//      controls people actually reach for: mute, video, hang up.
//
//  Media is not this component's business. Answering puts the user into the
//  voice room for the DM channel, and the existing VoiceRoom mesh takes it from
//  there — the same code path a guild voice channel uses.
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import { playSound } from '../utils/notifier';

const FALLBACK_AVATAR = '/avatar-placeholder.svg';

/** mm:ss for a call that started at `startedAt`. */
function useElapsed(startedAt) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!startedAt) return undefined;
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * The ringing card. Rendered at most once — a second incoming call while one is
 * already ringing replaces it, which is what Discord does too.
 */
export function IncomingCall({ call, channel, onAccept, onDecline }) {
  // Ring audibly, and keep ringing until the card goes away.
  const stopRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const ring = () => { if (!cancelled) playSound('call'); };
    ring();
    const timer = setInterval(ring, 3000);
    stopRef.current = () => { cancelled = true; clearInterval(timer); };
    return stopRef.current;
  }, [call?.id]);

  if (!call) return null;
  const caller = (call.participants ?? []).find((p) => p.user_id === call.initiator_id);
  const name = caller?.display_name || caller?.username || channel?.name || t('call.someone');

  return (
    <div
      className="fixed bottom-6 right-6 z-[70] w-72 rounded-xl bg-d-canvas border border-d-edge shadow-2xl p-4"
      role="alertdialog"
      aria-live="assertive"
      aria-label={t('call.incomingFrom', { name })}
    >
      <div className="flex items-center gap-3">
        <img
          src={caller?.avatar_url || FALLBACK_AVATAR}
          alt=""
          className="w-11 h-11 rounded-full object-cover shrink-0"
        />
        <div className="min-w-0">
          <p className="font-semibold text-d-strong truncate">{name}</p>
          <p className="text-xs text-d-text3">
            {call.video ? t('call.incomingVideo') : t('call.incoming')}
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => { stopRef.current?.(); onDecline?.(); }}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-d-danger/90 hover:bg-d-danger text-white text-sm font-semibold py-2"
        >
          <PhoneOff className="w-4 h-4" aria-hidden="true" />{t('call.decline')}
        </button>
        <button
          type="button"
          onClick={() => { stopRef.current?.(); onAccept?.(); }}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-d-success/90 hover:bg-d-success text-white text-sm font-semibold py-2"
        >
          <Phone className="w-4 h-4" aria-hidden="true" />{t('call.accept')}
        </button>
      </div>
    </div>
  );
}

/** The strip shown inside a conversation while a call is live. */
export function CallBar({ call, currentUserId, isMuted, onToggleMute, isVideo, onToggleVideo, onHangUp }) {
  const elapsed = useElapsed(call?.started_at);
  if (!call) return null;

  const inCall = (call.participants ?? []).filter((p) => p.state === 'joined');
  const ringing = (call.participants ?? []).filter((p) => p.state === 'ringing');
  const joined = inCall.some((p) => p.user_id === currentUserId);

  return (
    <div className="px-4 py-2 border-b border-d-edge bg-d-surface/60 flex items-center gap-3 flex-wrap">
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-d-strong">
        <Phone className="w-4 h-4 text-d-success" aria-hidden="true" />
        {t('call.inProgress')}
      </span>
      <span className="text-xs tabular-nums text-d-text3" aria-label={t('call.duration')}>{elapsed}</span>

      <div className="flex items-center -space-x-2">
        {inCall.map((p) => (
          <img
            key={p.user_id}
            src={p.avatar_url || FALLBACK_AVATAR}
            alt={p.display_name || p.username}
            title={p.display_name || p.username}
            className="w-6 h-6 rounded-full object-cover ring-2 ring-d-canvas"
          />
        ))}
      </div>
      {ringing.length > 0 && (
        <span className="text-xs text-d-text3">
          {t('call.ringingCount', { count: ringing.length })}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {joined && (
          <>
            <button
              type="button"
              onClick={onToggleMute}
              aria-pressed={isMuted}
              className="p-1.5 rounded-md hover:bg-d-surface text-d-text2 hover:text-d-strong"
              title={isMuted ? t('voice.unmute') : t('voice.mute')}
            >
              {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={onToggleVideo}
              aria-pressed={isVideo}
              className="p-1.5 rounded-md hover:bg-d-surface text-d-text2 hover:text-d-strong"
              title={isVideo ? t('call.stopVideo') : t('call.startVideo')}
            >
              {isVideo ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onHangUp}
          className="inline-flex items-center gap-1.5 rounded-md bg-d-danger/90 hover:bg-d-danger text-white text-xs font-semibold px-2.5 py-1.5"
        >
          <PhoneOff className="w-3.5 h-3.5" aria-hidden="true" />
          {joined ? t('call.hangUp') : t('call.join')}
        </button>
      </div>
    </div>
  );
}

export default CallBar;
