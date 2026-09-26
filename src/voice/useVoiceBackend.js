// ============================================================================
//  The voice media backend behind a voice room: the WebRTC mesh or LiveKit.
//
//  Both hooks are always called (rules of hooks) and exactly one is enabled.
//  Until the config answers, neither is — a few hundred milliseconds of
//  silence beats building a mesh that is torn down again a moment later.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { useVoicePeers } from '../hooks/useVoicePeers';
import { useLiveKitRoom } from './useLiveKitRoom';
import { loadVoiceConfig } from './config';

export function useVoiceBackend({ socket, channelId, participants, selfUserId, tracks, ...playback }) {
  const [config, setConfig] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadVoiceConfig().then((value) => { if (!cancelled) setConfig(value); });
    return () => { cancelled = true; };
  }, [channelId]);

  // The server turned LiveKit off since the config was read: re-ask (→ mesh).
  const onUnavailable = useCallback(() => {
    loadVoiceConfig({ force: true }).then((value) => setConfig(value.mode === 'livekit' ? { ...value, mode: 'mesh' } : value));
  }, []);

  const mode = config?.mode ?? null;

  const mesh = useVoicePeers({
    socket,
    tracks,
    participants,
    selfUserId,
    enabled: mode === 'mesh',
    ...playback
  });

  const sfu = useLiveKitRoom({
    enabled: mode === 'livekit',
    channelId,
    selfUserId,
    tracks,
    config,
    onUnavailable,
    ...playback
  });

  if (mode === 'livekit') return { ...sfu, mode };
  return {
    ...mesh,
    backend: 'mesh',
    mode: mode ?? 'pending',
    disconnectReason: null,
    error: null,
    e2ee: false,
    codec: null,
    selfQuality: null,
    retry: () => {}
  };
}
