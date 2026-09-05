import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Video, VideoOff, Loader2 } from 'lucide-react';
import { useVoiceSettings, listAudioDevices } from '../../hooks/useVoiceSettings';
import { t } from '../../i18n/index.jsx';
import {
  PageHeader, Section, SettingToggle, Slider, RadioList, ResetButton,
  Divider, StackedRow, Field, Select, Button, inputClass
} from './primitives';

const RESOLUTIONS = ['640x360', '854x480', '1280x720', '1920x1080'];
const FRAME_RATES = [15, 24, 30, 60];

/**
 * Voice & Video.
 *
 * Every control here drives the same audio graph the call uses: the device
 * pickers reopen the real stream, the volume sliders move a real gain node, the
 * mic test opens a live capture so the meter shows your own voice rather than an
 * animation, and the blur preview runs the exact canvas pipeline peers receive.
 */
export default function VoiceSettings({ onToast }) {
  const { settings, update, reset } = useVoiceSettings();
  const [devices, setDevices] = useState({ inputs: [], outputs: [], cameras: [] });
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [capturingKey, setCapturingKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);

  const streamRef = useRef(null);
  const ctxRef = useRef(null);
  const rafRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const cameraVideoRef = useRef(null);
  const blurCanvasRef = useRef(null);
  const blurTimerRef = useRef(null);

  const refreshDevices = async () => {
    try { setDevices(await listAudioDevices()); }
    catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
      stopTest();
      stopCameraPreview();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- microphone test -------------------------------------------------------

  const stopTest = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setLevel(0);
    setTesting(false);
  };

  const startTest = async () => {
    setBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.inputDeviceId !== 'default' ? { exact: settings.inputDeviceId } : undefined,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl
        }
      });
      streamRef.current = stream;
      refreshDevices();   // permission granted, so labels are available now

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      ctxRef.current = ctx;
      const gain = ctx.createGain();
      gain.gain.value = settings.inputVolume / 100;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(gain).connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(bins);
        let sum = 0;
        for (let i = 0; i < bins.length; i += 1) sum += bins[i];
        setLevel(Math.round(sum / bins.length));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      setTesting(true);
    } catch (err) {
      onToast?.(err.name === 'NotAllowedError' ? t('voice.micDenied') : err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // --- camera preview --------------------------------------------------------

  const stopCameraPreview = () => {
    clearTimeout(blurTimerRef.current);
    blurTimerRef.current = null;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    setCameraOn(false);
  };

  const startCameraPreview = async () => {
    setBusy(true);
    try {
      const [width, height] = settings.videoResolution.split('x').map(Number);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: settings.videoDeviceId !== 'default' ? { exact: settings.videoDeviceId } : undefined,
          width: { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: settings.videoFrameRate }
        }
      });
      cameraStreamRef.current = stream;
      refreshDevices();
      if (cameraVideoRef.current) {
        cameraVideoRef.current.srcObject = stream;
        cameraVideoRef.current.play().catch(() => {});
      }
      setCameraOn(true);
    } catch (err) {
      onToast?.(err.name === 'NotAllowedError' ? t('voice.cameraDenied') : err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // Re-open the preview when the device or quality changes while it is running.
  useEffect(() => {
    if (!cameraOn) return;
    stopCameraPreview();
    startCameraPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.videoDeviceId, settings.videoResolution, settings.videoFrameRate]);

  // The blur preview mirrors exactly what peers would receive.
  useEffect(() => {
    if (!cameraOn || !settings.blurCamera) return undefined;
    const canvas = blurCanvasRef.current;
    const video = cameraVideoRef.current;
    if (!canvas || !video) return undefined;
    const context = canvas.getContext('2d');

    const draw = () => {
      if (video.readyState >= 2) {
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 360;
        context.filter = `blur(${settings.blurStrength}px)`;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      blurTimerRef.current = setTimeout(draw, 1000 / 15);
    };
    draw();
    return () => clearTimeout(blurTimerRef.current);
  }, [cameraOn, settings.blurCamera, settings.blurStrength]);

  const captureKey = (event) => {
    event.preventDefault();
    if (event.code === 'Escape') { setCapturingKey(false); return; }
    update({ pushToTalkKey: event.code });
    setCapturingKey(false);
  };

  const threshold = settings.automaticSensitivity ? 20 : settings.sensitivity;
  const speaking = level > threshold;

  const deviceOptions = (list) => [
    <option key="default" value="default">{t('voice.systemDefault')}</option>,
    ...list.map((device) => (
      <option key={device.deviceId} value={device.deviceId}>
        {device.label || t('voice.unnamedDevice')}
      </option>
    ))
  ];

  return (
    <div>
      <PageHeader title={t('settings.voiceTitle')} description={t('settings.voiceLead')} />

      {/* --- devices ---------------------------------------------------------- */}
      <Section title={t('voice.devicesTitle')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('voice.inputDevice')} htmlFor="voice-input-device">
            <Select
              id="voice-input-device"
              label={t('voice.inputDevice')}
              value={settings.inputDeviceId}
              onChange={(value) => update({ inputDeviceId: value })}
            >
              {deviceOptions(devices.inputs)}
            </Select>
          </Field>
          <Field label={t('voice.outputDevice')} htmlFor="voice-output-device">
            <Select
              id="voice-output-device"
              label={t('voice.outputDevice')}
              value={settings.outputDeviceId}
              onChange={(value) => update({ outputDeviceId: value })}
            >
              {deviceOptions(devices.outputs)}
            </Select>
          </Field>
        </div>

        <Slider
          label={t('voice.inputVolume')}
          value={settings.inputVolume}
          min={0} max={200} step={5}
          format={(v) => `${v}%`}
          onChange={(value) => update({ inputVolume: value })}
        />
        <Slider
          label={t('voice.outputVolume')}
          value={settings.outputVolume}
          min={0} max={200} step={5}
          format={(v) => `${v}%`}
          onChange={(value) => update({ outputVolume: value })}
          last
        />
      </Section>

      {/* --- mic check --------------------------------------------------------- */}
      <Section title={t('voice.micTest')} description={t('voice.micTestHint')}>
        <div className="rounded-lg border border-d-divider bg-d-surface p-4">
          <div className="mb-3 flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-d-strong">
              {testing ? t('voice.listening') : t('voice.notListening')}
            </span>
            <Button
              variant={testing ? 'danger' : 'primary'}
              size="sm"
              onClick={testing ? stopTest : startTest}
              disabled={busy}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : testing ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
              {testing ? t('voice.stopTest') : t('voice.startTest')}
            </Button>
          </div>

          <div
            className="relative h-3 overflow-hidden rounded-full bg-d-sunken"
            role="meter"
            aria-label={t('voice.inputLevel')}
            aria-valuenow={Math.min(100, level)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-75
                ${speaking ? 'bg-d-online' : 'bg-d-control'}`}
              style={{ width: `${Math.min(100, level * 1.6)}%` }}
            />
            {!settings.automaticSensitivity && (
              <span
                className="absolute inset-y-0 w-[2px] bg-d-danger"
                style={{ left: `${Math.min(100, settings.sensitivity * 1.6)}%` }}
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      </Section>

      <Divider />

      {/* --- input mode --------------------------------------------------------- */}
      <Section title={t('voice.inputMode')}>
        <RadioList
          label={t('voice.inputMode')}
          value={settings.inputMode}
          onChange={(value) =>
            update({ inputMode: value, pushToTalk: value === 'ptt' })}
          options={[
            { key: 'voice', label: t('voice.voiceActivity'), hint: t('voice.voiceActivityHint') },
            { key: 'ptt',   label: t('voice.pushToTalk'),    hint: t('voice.pushToTalkHint') }
          ]}
        />

        {settings.inputMode === 'ptt' && (
          <div className="mt-4 border-l-2 border-d-divider pl-4">
            <Row2 label={t('voice.keybind')}>
              <button
                type="button"
                onClick={() => setCapturingKey(true)}
                onKeyDown={capturingKey ? captureKey : undefined}
                onBlur={() => setCapturingKey(false)}
                aria-label={t('voice.keybind')}
                className={`min-w-[128px] rounded-md border px-3 py-1.5 text-center font-mono text-xs
                  transition-colors ${capturingKey
                    ? 'animate-pulse border-d-brand bg-d-brand/10 text-d-mention'
                    : 'border-d-divider bg-d-sunken text-d-strong hover:border-d-control'}`}
              >
                {capturingKey ? t('voice.pressAKey') : settings.pushToTalkKey}
              </button>
            </Row2>
            <Slider
              label={t('voice.releaseDelay')}
              hint={t('voice.releaseDelayHint')}
              value={settings.pushToTalkReleaseMs}
              min={0} max={2000} step={20}
              format={(v) => `${v} ms`}
              onChange={(value) => update({ pushToTalkReleaseMs: value })}
              last
            />
          </div>
        )}

        {settings.inputMode === 'voice' && (
          <div className="mt-4 border-l-2 border-d-divider pl-4">
            <SettingToggle
              label={t('voice.automaticSensitivity')}
              hint={t('voice.automaticSensitivityHint')}
              checked={settings.automaticSensitivity}
              onChange={(value) => update({ automaticSensitivity: value })}
              last={settings.automaticSensitivity}
            />
            {!settings.automaticSensitivity && (
              <Slider
                label={t('voice.sensitivity')}
                hint={t('voice.sensitivityHint')}
                value={settings.sensitivity}
                min={0} max={60} step={1}
                onChange={(value) => update({ sensitivity: value })}
                last
              />
            )}
          </div>
        )}
      </Section>

      <Divider />

      {/* --- processing --------------------------------------------------------- */}
      <Section title={t('voice.processing')}>
        <SettingToggle
          label={t('voice.echoCancellation')}
          checked={settings.echoCancellation}
          onChange={(value) => update({ echoCancellation: value })}
        />
        <SettingToggle
          label={t('voice.noiseSuppression')}
          checked={settings.noiseSuppression}
          onChange={(value) => update({ noiseSuppression: value })}
        />
        <SettingToggle
          label={t('voice.autoGain')}
          checked={settings.autoGainControl}
          onChange={(value) => update({ autoGainControl: value })}
          last
        />
      </Section>

      <Divider />

      {/* --- attenuation --------------------------------------------------------- */}
      <Section title={t('voice.attenuation')} description={t('voice.attenuationHint')}>
        <Slider
          label={t('voice.attenuationAmount')}
          value={settings.attenuation}
          min={0} max={100} step={5}
          format={(v) => `${v}%`}
          onChange={(value) => update({ attenuation: value })}
        />
        <SettingToggle
          label={t('voice.attenuateWhenSpeaking')}
          checked={settings.attenuateWhileSpeaking}
          onChange={(value) => update({ attenuateWhileSpeaking: value })}
          last
        />
      </Section>

      <Divider />

      {/* --- video ---------------------------------------------------------------- */}
      <Section title={t('voice.videoSettings')}>
        <Field label={t('voice.camera')} htmlFor="voice-camera" className="mb-4">
          <Select
            id="voice-camera"
            label={t('voice.camera')}
            value={settings.videoDeviceId}
            onChange={(value) => update({ videoDeviceId: value })}
          >
            {deviceOptions(devices.cameras)}
          </Select>
        </Field>

        <div className="relative mb-4 flex aspect-video items-center justify-center
          overflow-hidden rounded-xl bg-black">
          <video
            ref={cameraVideoRef}
            muted
            playsInline
            className={`h-full w-full object-cover ${settings.blurCamera ? 'invisible absolute' : ''}
              ${settings.mirrorCamera ? 'scale-x-[-1]' : ''}`}
          />
          {settings.blurCamera && (
            <canvas
              ref={blurCanvasRef}
              className={`h-full w-full object-cover ${settings.mirrorCamera ? 'scale-x-[-1]' : ''}`}
            />
          )}
          {!cameraOn && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-d-text3">
              <VideoOff className="h-8 w-8" aria-hidden="true" />
              <p className="text-sm">{t('voice.cameraOffPreview')}</p>
            </div>
          )}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
            <Button
              variant={cameraOn ? 'danger' : 'primary'}
              size="sm"
              onClick={cameraOn ? stopCameraPreview : startCameraPreview}
              disabled={busy}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : cameraOn ? <VideoOff className="h-3.5 w-3.5" /> : <Video className="h-3.5 w-3.5" />}
              {cameraOn ? t('voice.stopVideoTest') : t('voice.testVideo')}
            </Button>
          </div>
        </div>

        <div className="mb-2 grid gap-4 sm:grid-cols-2">
          <Field label={t('voice.resolution')} htmlFor="voice-resolution">
            <select
              id="voice-resolution"
              value={settings.videoResolution}
              onChange={(event) => update({ videoResolution: event.target.value })}
              className={`${inputClass} cursor-pointer`}
            >
              {RESOLUTIONS.map((r) => <option key={r} value={r}>{r.replace('x', ' × ')}</option>)}
            </select>
          </Field>
          <Field label={t('voice.frameRate')} htmlFor="voice-framerate">
            <select
              id="voice-framerate"
              value={settings.videoFrameRate}
              onChange={(event) => update({ videoFrameRate: Number(event.target.value) })}
              className={`${inputClass} cursor-pointer`}
            >
              {FRAME_RATES.map((f) => <option key={f} value={f}>{t('voice.fps', { count: f })}</option>)}
            </select>
          </Field>
        </div>

        <SettingToggle
          label={t('voice.mirrorCamera')}
          hint={t('voice.mirrorCameraHint')}
          checked={settings.mirrorCamera}
          onChange={(value) => update({ mirrorCamera: value })}
        />
        <SettingToggle
          label={t('voice.blurCamera')}
          hint={t('voice.blurCameraHint')}
          checked={settings.blurCamera}
          onChange={(value) => update({ blurCamera: value })}
          last={!settings.blurCamera}
        />
        {settings.blurCamera && (
          <Slider
            label={t('voice.blurStrength')}
            value={settings.blurStrength}
            min={1} max={40} step={1}
            format={(v) => `${v}px`}
            onChange={(value) => update({ blurStrength: value })}
            last
          />
        )}
      </Section>

      <Divider />

      {/* --- behaviour ------------------------------------------------------------- */}
      <Section title={t('voice.behaviour')}>
        <Slider
          label={t('voice.soundboardVolume')}
          value={settings.soundboardVolume}
          min={0} max={200} step={5}
          format={(v) => `${v}%`}
          onChange={(value) => update({ soundboardVolume: value })}
        />
        <SettingToggle
          label={t('voice.showSpeakingIndicator')}
          checked={settings.showSpeakingIndicator}
          onChange={(value) => update({ showSpeakingIndicator: value })}
        />
        <SettingToggle
          label={t('voice.silenceWarningSetting')}
          hint={t('voice.silenceWarningHint')}
          checked={settings.silenceWarning}
          onChange={(value) => update({ silenceWarning: value })}
        />
        <SettingToggle
          label={t('voice.joinLeaveSounds')}
          checked={settings.voiceJoinSound}
          onChange={(value) => update({ voiceJoinSound: value })}
        />
        <SettingToggle
          label={t('voice.spatialAudio')}
          hint={t('voice.spatialAudioHint')}
          checked={settings.spatialAudio}
          onChange={(value) => update({ spatialAudio: value })}
          last
        />
      </Section>

      <ResetButton
        onClick={() => { reset(); onToast?.(t('voice.resetDone'), { type: 'success', ttl: 2500 }); }}
      >
        {t('voice.resetDefaults')}
      </ResetButton>
    </div>
  );
}

/** A label/control pair inside an indented sub-block, without the hairline. */
function Row2({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-d-divider py-4">
      <span className="text-base font-medium text-d-strong">{label}</span>
      {children}
    </div>
  );
}
