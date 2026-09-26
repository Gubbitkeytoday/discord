import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/index.jsx';
import { useVoiceSettings } from './useVoiceSettings';

const SPEAKING_RELEASE_MS = 250;    // hold before declaring silence, avoids flicker
const LEVEL_INTERVAL_MS = 50;       // 20 Hz is plenty for a meter and for VAD

/** A translation, or English when the key has not been added yet. */
function tr(key, fallback) {
  const text = t(key);
  return text === key ? fallback : text;
}

/**
 * Turn a getUserMedia failure into something the user can act on. The raw
 * DOMException names mean nothing to most people.
 */
export function describeMediaError(err, kind = 'mic') {
  const device = kind === 'camera' ? 'camera' : kind === 'screen' ? 'screen' : 'microphone';
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return kind === 'camera' ? t('voice.cameraDenied') : t('voice.micDenied');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return tr(`voice.${kind}NotFound`, `No ${device} was found. Plug one in or pick another in Voice settings.`);
    case 'NotReadableError':
    case 'AbortError':
      return tr(`voice.${kind}Busy`, `Your ${device} is in use by another app, or the system blocked it.`);
    case 'InsecureContext':
      return tr('voice.insecureContext', 'Voice and video need HTTPS (or localhost). Open this site over https://.');
    default:
      return err?.message || String(err);
  }
}

/** getUserMedia exists only in a secure context; on plain http it is undefined. */
function mediaDevicesOrThrow() {
  if (!navigator.mediaDevices?.getUserMedia) {
    const err = new Error('insecure context');
    err.name = 'InsecureContext';
    throw err;
  }
  return navigator.mediaDevices;
}

/**
 * Owns the local microphone, camera and screen-share streams, plus the
 * voice-activity analysis that decides whether the user is speaking.
 *
 * Kept in a hook rather than the component so the media lifecycle survives
 * re-renders: acquiring getUserMedia on every render would prompt the user
 * repeatedly and leak tracks.
 */
export function useVoiceMedia({ enabled, isMuted, pushToTalk: pushToTalkProp, onSpeakingChange }) {
  // Device choice, gain and sensitivity come from the user's saved voice
  // settings; the caller only says whether voice is on and whether it is muted.
  const { settings } = useVoiceSettings();
  // `inputMode` is the setting of record; the prop is an override for callers
  // that toggle push-to-talk from the call UI.
  const pushToTalk = pushToTalkProp ?? (settings.inputMode === 'ptt' || settings.pushToTalk);
  const PTT_KEY = settings.pushToTalkKey || 'Space';
  const releaseMs = Number(settings.pushToTalkReleaseMs) || SPEAKING_RELEASE_MS;
  const [micLevel, setMicLevel] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [pttHeld, setPttHeld] = useState(false);
  const [cameraStream, setCameraStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [error, setError] = useState(null);
  const [micStream, setMicStream] = useState(null);
  // Bumped when the microphone disappears mid-call (unplugged headset), so the
  // capture effect runs again and falls back to another device.
  const [micEpoch, setMicEpoch] = useState(0);

  const micStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const gainRef = useRef(null);
  const rawCameraRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const blurPipelineRef = useRef(null);
  const blurTimerRef = useRef(null);
  const destinationRef = useRef(null);
  // Manual sensitivity is the slider; automatic tracks the room's noise floor
  // and sits a margin above it, which is what Discord's "automatic" does.
  const thresholdRef = useRef(settings.sensitivity);
  const noiseFloorRef = useRef(settings.sensitivity);
  const autoRef = useRef(settings.automaticSensitivity);
  autoRef.current = settings.automaticSensitivity;
  if (!settings.automaticSensitivity) thresholdRef.current = settings.sensitivity;
  const releaseRef = useRef(releaseMs);
  releaseRef.current = releaseMs;
  const [effectiveThreshold, setEffectiveThreshold] = useState(settings.sensitivity);
  const rafRef = useRef(null);
  const lastLoudAtRef = useRef(0);
  const speakingRef = useRef(false);

  // Effective transmit state: muted always wins; with PTT on you must hold the key.
  const transmitting = !isMuted && (!pushToTalk || pttHeld);
  const transmittingRef = useRef(transmitting);
  transmittingRef.current = transmitting;

  // --- microphone + level analysis -----------------------------------------
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const devicesApi = mediaDevicesOrThrow();
        const processing = {
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl
        };
        const chosen = settings.inputDeviceId && settings.inputDeviceId !== 'default'
          ? settings.inputDeviceId : null;
        let stream;
        try {
          stream = await devicesApi.getUserMedia({
            audio: { ...processing, ...(chosen ? { deviceId: { exact: chosen } } : {}) }
          });
        } catch (err) {
          // The saved device is gone (unplugged, or ids reset after clearing
          // site data). Joining with the default mic beats joining with none.
          if (!chosen || !['OverconstrainedError', 'NotFoundError'].includes(err.name)) throw err;
          stream = await devicesApi.getUserMedia({ audio: processing });
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        micStreamRef.current = stream;
        setError(null);
        stream.getAudioTracks()[0]?.addEventListener('ended', () => {
          if (!cancelled) setMicEpoch((n) => n + 1);
        });

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        audioContextRef.current = ctx;
        // A context created outside a click can start suspended, and a
        // suspended graph sends silence to every peer.
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const source = ctx.createMediaStreamSource(stream);

        // Input volume is a real gain stage in front of what we transmit, so
        // 150% is genuinely louder to the other side, not just a bigger meter.
        const gain = ctx.createGain();
        gain.gain.value = settings.inputVolume / 100;
        gainRef.current = gain;
        const destination = ctx.createMediaStreamDestination();
        destinationRef.current = destination;
        source.connect(gain);
        gain.connect(destination);

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        gain.connect(analyser);
        const bins = new Uint8Array(analyser.frequencyBinCount);

        // What peers receive is the processed stream, not the raw device. Its
        // track starts enabled; gate it before anyone can receive it, so a
        // muted or push-to-talk user never leaks the first few frames.
        destination.stream.getAudioTracks().forEach((track) => { track.enabled = transmittingRef.current; });
        setMicStream(destination.stream);

        // A timer rather than requestAnimationFrame: rAF stops in a background
        // tab, which would freeze the speaking state at whatever it last was.
        const tick = () => {
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
          analyser.getByteFrequencyData(bins);
          let sum = 0;
          for (let i = 0; i < bins.length; i += 1) sum += bins[i];
          const level = Math.round(sum / bins.length);
          setMicLevel(level);

          if (autoRef.current) {
            // Follow the floor down quickly and up slowly, so a fan or a hiss
            // stops counting as speech without swallowing the start of a word.
            const floor = noiseFloorRef.current;
            // (Coefficients are per 50 ms tick — same time constants as the
            // earlier per-frame 0.2 / 0.005 at 60 fps.)
            noiseFloorRef.current = level < floor ? level * 0.5 + floor * 0.5 : floor * 0.985 + level * 0.015;
            thresholdRef.current = Math.max(6, noiseFloorRef.current + 8);
          }

          const loud = level > thresholdRef.current;
          if (loud) lastLoudAtRef.current = Date.now();
          // Release only after a short quiet period, so normal speech gaps do
          // not strobe the speaking ring.
          const next = loud || Date.now() - lastLoudAtRef.current < releaseRef.current;

          if (next !== speakingRef.current) {
            speakingRef.current = next;
            setIsSpeaking(next);
          }
          setEffectiveThreshold(Math.round(thresholdRef.current));
        };
        rafRef.current = setInterval(tick, LEVEL_INTERVAL_MS);
      } catch (err) {
        if (!cancelled) setError(describeMediaError(err, 'mic'));
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) clearInterval(rafRef.current);
      rafRef.current = null;
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      setMicStream(null);
      audioContextRef.current?.close().catch(() => {});
      audioContextRef.current = null;
      gainRef.current = null;
      destinationRef.current = null;
      setMicLevel(0);
      setIsSpeaking(false);
      speakingRef.current = false;
    };
    // Re-acquiring on a device or processing change is deliberate: those
    // constraints can only be applied when the track is created.
  }, [enabled, micEpoch, settings.inputDeviceId, settings.echoCancellation, settings.noiseSuppression, settings.autoGainControl]);

  // Volume, by contrast, is a live parameter — no need to disturb the stream.
  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = settings.inputVolume / 100;
  }, [settings.inputVolume]);

  // Gate the outgoing (processed) track instead of tearing the stream down, so
  // unmute is instant. The raw capture stays live for the local analyser only.
  // Re-run when a new stream arrives: a fresh track starts enabled, and a
  // device switch while muted must not open the mic.
  useEffect(() => {
    micStream?.getAudioTracks().forEach((track) => {
      track.enabled = transmitting;
    });
  }, [transmitting, micStream]);

  // Tell the rest of the app (and the server) about speaking transitions.
  useEffect(() => {
    onSpeakingChange?.(isSpeaking && transmitting);
  }, [isSpeaking, transmitting, onSpeakingChange]);

  // --- push to talk ---------------------------------------------------------
  useEffect(() => {
    if (!pushToTalk || !enabled) return undefined;

    const isTextField = (el) => ['INPUT', 'TEXTAREA'].includes(el?.tagName) || el?.isContentEditable;
    const down = (e) => {
      if (e.code !== PTT_KEY || isTextField(e.target)) return;
      e.preventDefault();  // Space would otherwise scroll the page
      setPttHeld(true);
    };
    const up = (e) => {
      if (e.code !== PTT_KEY) return;
      setPttHeld(false);
    };
    // Releasing focus while holding must not latch the mic open.
    const blur = () => setPttHeld(false);

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      setPttHeld(false);
    };
  }, [pushToTalk, enabled, PTT_KEY]);

  /**
   * The on-screen hold-to-talk button (touch screens have no key to hold).
   * Pressing opens the mic exactly like the key does; the caller releases it
   * on pointerup / pointercancel / lostpointercapture. A no-op outside PTT.
   */
  const holdToTalk = useCallback((held) => {
    if (!pushToTalk || !enabled) return;
    setPttHeld(Boolean(held));
  }, [pushToTalk, enabled]);

  // --- camera ---------------------------------------------------------------

  /**
   * Open the camera at the configured device and quality.
   *
   * When "blur my camera" is on the raw feed is drawn through a canvas with a
   * CSS filter and captured again, so what peers receive is the blurred frame —
   * not a preview-only effect. It needs no model download and works offline.
   */
  const startCamera = useCallback(async (overrides = {}) => {
    const wanted = { ...settings, ...overrides };
    const [width, height] = (wanted.videoResolution ?? '1280x720').split('x').map(Number);
    try {
      const raw = await mediaDevicesOrThrow().getUserMedia({
        video: {
          deviceId: wanted.videoDeviceId && wanted.videoDeviceId !== 'default'
            ? { exact: wanted.videoDeviceId }
            : undefined,
          width: { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: Number(wanted.videoFrameRate) || 30 }
        }
      });
      rawCameraRef.current = raw;
      const outgoing = wanted.blurCamera ? startBlurPipeline(raw, wanted) : raw;
      raw.getVideoTracks()[0]?.addEventListener('ended', () => stopCamera());
      cameraStreamRef.current = outgoing;
      setCameraStream(outgoing);
      return outgoing;
    } catch (err) {
      setError(describeMediaError(err, 'camera'));
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const stopCamera = useCallback(() => {
    stopBlurPipeline();
    rawCameraRef.current?.getTracks().forEach((track) => track.stop());
    rawCameraRef.current = null;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    setCameraStream(null);
  }, []);

  const toggleCamera = useCallback(async () => {
    if (rawCameraRef.current) { stopCamera(); return null; }
    return startCamera();
  }, [startCamera, stopCamera]);

  /** Draw the camera into a canvas with a blur filter and capture that instead. */
  function startBlurPipeline(source, wanted) {
    const video = document.createElement('video');
    video.srcObject = source;
    video.muted = true;
    video.playsInline = true;
    video.play().catch(() => {});

    const [width, height] = (wanted.videoResolution ?? '1280x720').split('x').map(Number);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const fps = Number(wanted.videoFrameRate) || 30;

    const draw = () => {
      if (video.readyState >= 2) {
        context.filter = `blur(${Math.max(1, Number(wanted.blurStrength) || 12)}px)`;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      blurTimerRef.current = setTimeout(draw, 1000 / fps);
    };
    draw();

    blurPipelineRef.current = { video, canvas };
    return canvas.captureStream(fps);
  }

  function stopBlurPipeline() {
    clearTimeout(blurTimerRef.current);
    blurTimerRef.current = null;
    const pipeline = blurPipelineRef.current;
    if (pipeline) {
      pipeline.video.srcObject = null;
      blurPipelineRef.current = null;
    }
  }

  // --- screen share ---------------------------------------------------------
  const stopScreenShare = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    setScreenStream(null);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    if (screenStreamRef.current) { stopScreenShare(); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError(tr('voice.screenShareUnsupported', 'Screen sharing is not supported in this browser.'));
      return;
    }
    try {
      // Tab/system audio is offered where the browser supports it (Chromium);
      // elsewhere the share is simply silent. Processing is off: voice-tuned
      // noise suppression mangles music and game audio.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude'
      });
      const video = stream.getVideoTracks()[0];
      // Text and UI stay legible: prefer resolution over frame rate.
      if (video && 'contentHint' in video) video.contentHint = 'detail';
      // The browser's own "Stop sharing" bar bypasses our button entirely.
      video?.addEventListener('ended', stopScreenShare);
      screenStreamRef.current = stream;
      setScreenStream(stream);
    } catch (err) {
      // A cancelled picker is not an error worth showing.
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') setError(describeMediaError(err, 'screen'));
    }
  }, [stopScreenShare]);

  // Re-open the camera when the device, quality or blur choice changes, so a
  // change in Settings takes effect on the call already in progress.
  const cameraSignature = `${settings.videoDeviceId}|${settings.videoResolution}|${settings.videoFrameRate}|${settings.blurCamera}|${settings.blurStrength}`;
  const lastCameraSignature = useRef(cameraSignature);
  useEffect(() => {
    if (lastCameraSignature.current === cameraSignature) return;
    lastCameraSignature.current = cameraSignature;
    if (!rawCameraRef.current) return;
    stopCamera();
    startCamera();
  }, [cameraSignature, startCamera, stopCamera]);

  // Leaving voice (or unmounting) must release the camera and the screen
  // share too — otherwise the browser keeps showing "sharing your screen" and
  // the camera light stays on after the call has ended.
  useEffect(() => {
    if (enabled) return;
    stopCamera();
    stopScreenShare();
  }, [enabled, stopCamera, stopScreenShare]);

  useEffect(() => () => {
    stopBlurPipeline();
    rawCameraRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The mesh takes the three tracks separately — each has its own transceiver,
  // so a camera can come and go without touching the audio path.
  const outgoingTracks = useMemo(() => ({
    audio: micStream?.getAudioTracks()[0] ?? null,
    camera: cameraStream?.getVideoTracks()[0] ?? null,
    screen: screenStream?.getVideoTracks()[0] ?? null,
    screenAudio: screenStream?.getAudioTracks()[0] ?? null
  }), [micStream, cameraStream, screenStream]);

  return {
    micStream,
    outgoingTracks,
    effectiveThreshold,
    startCamera,
    stopCamera,
    micLevel,
    isSpeaking: isSpeaking && transmitting,
    // Only true when something is actually being sent: a denied or missing
    // microphone must not show as "Transmitting".
    transmitting: transmitting && Boolean(micStream),
    hasMic: Boolean(micStream),
    pttHeld,
    pushToTalk,
    holdToTalk,
    cameraStream,
    screenStream,
    toggleCamera,
    toggleScreenShare,
    error,
    clearError: () => setError(null)
  };
}

/** Attach a MediaStream to a <video> element via ref. */
export function useStreamVideo(stream) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // A LiveKit remote track is attached through the SDK, so adaptiveStream
    // knows the element's size and visibility (and pauses hidden video).
    const lkTrack = stream?.lkTrack;
    if (lkTrack?.attach) {
      lkTrack.attach(el);
      return () => { try { lkTrack.detach(el); } catch { /* already gone */ } };
    }
    el.srcObject = stream ?? null;
    if (stream) el.play().catch(() => { /* autoplay blocked; muted so unlikely */ });
    return undefined;
  }, [stream]);
  return ref;
}
