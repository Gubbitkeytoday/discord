import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/index.jsx';
import { useVoiceSettings } from './useVoiceSettings';

const SPEAKING_RELEASE_MS = 250;    // hold before declaring silence, avoids flicker

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

  const micStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const gainRef = useRef(null);
  const rawCameraRef = useRef(null);
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

  // --- microphone + level analysis -----------------------------------------
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: settings.inputDeviceId && settings.inputDeviceId !== 'default'
              ? { exact: settings.inputDeviceId }
              : undefined,
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl: settings.autoGainControl
          }
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        micStreamRef.current = stream;

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        audioContextRef.current = ctx;
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

        // What peers receive is the processed stream, not the raw device.
        setMicStream(destination.stream);

        const tick = () => {
          analyser.getByteFrequencyData(bins);
          let sum = 0;
          for (let i = 0; i < bins.length; i += 1) sum += bins[i];
          const level = Math.round(sum / bins.length);
          setMicLevel(level);

          if (autoRef.current) {
            // Follow the floor down quickly and up slowly, so a fan or a hiss
            // stops counting as speech without swallowing the start of a word.
            const floor = noiseFloorRef.current;
            noiseFloorRef.current = level < floor ? level * 0.2 + floor * 0.8 : floor * 0.995 + level * 0.005;
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
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        setError(err.name === 'NotAllowedError' ? t('voice.micDenied') : err.message);
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
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
  }, [enabled, settings.inputDeviceId, settings.echoCancellation, settings.noiseSuppression, settings.autoGainControl]);

  // Volume, by contrast, is a live parameter — no need to disturb the stream.
  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = settings.inputVolume / 100;
  }, [settings.inputVolume]);

  // Gate the outgoing audio track instead of tearing the stream down, so the
  // level meter keeps working while muted and unmute is instant.
  useEffect(() => {
    micStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = transmitting;
    });
    // The processed track feeding the peers must follow the same gate.
    destinationRef.current?.stream?.getAudioTracks().forEach((track) => {
      track.enabled = transmitting;
    });
  }, [transmitting]);

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
      const raw = await navigator.mediaDevices.getUserMedia({
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
      setCameraStream(outgoing);
      return outgoing;
    } catch (err) {
      setError(err.name === 'NotAllowedError' ? t('voice.cameraDenied') : err.message);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const stopCamera = useCallback(() => {
    stopBlurPipeline();
    rawCameraRef.current?.getTracks().forEach((track) => track.stop());
    rawCameraRef.current = null;
    setCameraStream((current) => {
      current?.getTracks().forEach((track) => track.stop());
      return null;
    });
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
  const toggleScreenShare = useCallback(async () => {
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      setScreenStream(null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true
      });
      // The browser's own "Stop sharing" bar bypasses our button entirely.
      stream.getVideoTracks()[0].addEventListener('ended', () => setScreenStream(null));
      setScreenStream(stream);
    } catch (err) {
      // A cancelled picker is not an error worth showing.
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') setError(err.message);
    }
  }, [screenStream]);

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

  useEffect(() => () => {
    stopBlurPipeline();
    rawCameraRef.current?.getTracks().forEach((track) => track.stop());
    cameraStream?.getTracks().forEach((track) => track.stop());
    screenStream?.getTracks().forEach((track) => track.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The mesh takes the three tracks separately — each has its own transceiver,
  // so a camera can come and go without touching the audio path.
  const outgoingTracks = useMemo(() => ({
    audio: micStream?.getAudioTracks()[0] ?? null,
    camera: cameraStream?.getVideoTracks()[0] ?? null,
    screen: screenStream?.getVideoTracks()[0] ?? null
  }), [micStream, cameraStream, screenStream]);

  return {
    micStream,
    outgoingTracks,
    effectiveThreshold,
    startCamera,
    stopCamera,
    micLevel,
    isSpeaking: isSpeaking && transmitting,
    transmitting,
    pttHeld,
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
    if (!el) return;
    el.srcObject = stream ?? null;
    if (stream) el.play().catch(() => { /* autoplay blocked; muted so unlikely */ });
  }, [stream]);
  return ref;
}
