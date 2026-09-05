// ============================================================================
//  Voice note: the recorder in the composer, and the player in a message.
//
//  Discord's player is a play button, a scrubbable waveform and a duration.
//  The waveform doubles as the seek bar — that is the whole design, and it
//  works because a voice note is short enough that the shape is a usable map of
//  the content ("the pause is about here").
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { Mic, Send, Trash2, Play, Pause, Loader2 } from 'lucide-react';
import { formatDuration, startVoiceNote, analyseRecording, isVoiceNoteSupported } from '../utils/voiceNote';
import { t } from '../i18n/index.jsx';

/* --- player ----------------------------------------------------------------- */

/**
 * A recorded note inside a message.
 *
 * Progress is driven by `timeupdate` rather than a rAF loop: it fires often
 * enough for a 60-bar waveform and stops on its own when the audio is paused,
 * so a channel full of voice notes costs nothing while nothing is playing.
 */
export function VoiceNotePlayer({ attachment }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);   // 0–1

  const bars = attachment.waveform?.length ? attachment.waveform : null;
  const duration = attachment.duration_secs ?? 0;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const onTime = () => setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
    const onEnd = () => { setPlaying(false); setProgress(0); };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnd);
    };
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { audio.play().then(() => setPlaying(true)).catch(() => {}); }
  };

  const seek = (event) => {
    const audio = audioRef.current;
    if (!audio?.duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    setProgress(ratio);
  };

  return (
    <div className="mt-1 flex max-w-sm items-center gap-3 rounded-full border border-d-divider
      bg-d-surface px-3 py-2">
      <audio ref={audioRef} src={attachment.url} preload="metadata" />

      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t('voiceNote.pause') : t('voiceNote.play')}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-d-brand
          text-white transition-colors hover:bg-d-brandhover"
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>

      {bars ? (
        <button
          type="button"
          onClick={seek}
          aria-label={t('voiceNote.seek')}
          className="flex h-8 flex-1 items-end gap-[2px]"
        >
          {bars.map((height, index) => {
            const played = index / bars.length <= progress;
            return (
              <span
                key={index}
                aria-hidden="true"
                className={`flex-1 rounded-full transition-colors ${
                  played ? 'bg-d-brand' : 'bg-d-control'
                }`}
                // A bar of literally zero height is invisible and makes the
                // waveform look truncated; 8% keeps silence legible as silence.
                style={{ height: `${Math.max(8, height)}%` }}
              />
            );
          })}
        </button>
      ) : (
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-d-control">
          <div className="h-full bg-d-brand" style={{ width: `${progress * 100}%` }} />
        </div>
      )}

      <span className="shrink-0 text-xs tabular-nums text-d-text2">
        {formatDuration(duration * (progress || 0) || duration)}
      </span>
    </div>
  );
}

/* --- recorder ---------------------------------------------------------------- */

/**
 * The composer's recorder.
 *
 * It replaces the text input while recording rather than sitting beside it,
 * because there is nothing else you can usefully do mid-recording and a
 * half-typed message plus a running microphone is a confusing state to leave
 * someone in.
 */
export function VoiceNoteRecorder({ onSend, onCancel, onToast }) {
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const handleRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    startVoiceNote()
      .then((handle) => {
        if (cancelled) { handle.cancel(); return; }
        handleRef.current = handle;

        // A live level meter, so you can see the microphone is actually hearing
        // you. Recording in silence and only finding out on playback is the
        // single most annoying way for this feature to fail.
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(handle.stream).connect(analyser);
        analyserRef.current = { ctx, analyser };

        const bins = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(bins);
          let sum = 0;
          for (let i = 0; i < bins.length; i += 1) sum += bins[i];
          setLevel(Math.min(100, (sum / bins.length) * 2));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch((err) => {
        onToast?.(err.name === 'NotAllowedError' ? t('voice.micDenied') : err.message,
          { type: 'error' });
        onCancel();
      });

    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      analyserRef.current?.ctx.close().catch(() => {});
      handleRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = async () => {
    const handle = handleRef.current;
    if (!handle || busy) return;
    setBusy(true);
    try {
      const blob = await handle.stop();
      handleRef.current = null;          // stop() already released the microphone
      if (blob.size === 0) throw new Error(t('voiceNote.empty'));
      const { waveform, durationSecs } = await analyseRecording(blob);
      await onSend({ blob, waveform, durationSecs, mimeType: handle.mimeType });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 items-center gap-3 px-2">
      <span className="flex h-3 w-3 shrink-0 items-center justify-center">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-d-danger" />
      </span>

      <span className="shrink-0 text-sm tabular-nums text-d-strong">{formatDuration(elapsed)}</span>

      {/* The meter is decorative — the timer is the accessible signal. */}
      <div aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-d-control">
        <div
          className="h-full rounded-full bg-d-online transition-[width] duration-75"
          style={{ width: `${level}%` }}
        />
      </div>

      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        aria-label={t('voiceNote.discard')}
        title={t('voiceNote.discard')}
        className="rounded-full p-2 text-d-text2 transition-colors hover:bg-d-hover hover:text-d-danger"
      >
        <Trash2 className="h-5 w-5" />
      </button>

      <button
        type="button"
        onClick={finish}
        disabled={busy}
        aria-label={t('voiceNote.send')}
        title={t('voiceNote.send')}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-d-brand text-white
          transition-colors hover:bg-d-brandhover disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
      </button>
    </div>
  );
}

/** The button that starts a recording; hidden entirely where it cannot work. */
export function VoiceNoteButton({ onStart, disabled }) {
  if (!isVoiceNoteSupported()) return null;
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={disabled}
      title={t('voiceNote.record')}
      aria-label={t('voiceNote.record')}
      className="pb-0.5 text-d-text2 transition-colors hover:text-d-strong disabled:opacity-50"
    >
      <Mic className="h-6 w-6" />
    </button>
  );
}
