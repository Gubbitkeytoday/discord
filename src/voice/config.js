// ============================================================================
//  Which media path this server uses for voice: the peer-to-peer mesh, or a
//  LiveKit SFU. Asked once per join (GET /api/voice/config); anything short of
//  a clear "livekit" answer means mesh, so an older server or a network error
//  keeps voice working exactly as before.
// ============================================================================

import { get, post } from '../api';

const MAX_AGE_MS = 5 * 60 * 1000;
let cache = null;   // { value, at }

export async function loadVoiceConfig({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < MAX_AGE_MS) return cache.value;
  let value = { mode: 'mesh', livekit: null };
  try {
    const remote = await get('/api/voice/config');
    if (remote?.mode === 'livekit' && remote.livekit?.url) value = remote;
    else if (remote) value = { ...remote, mode: 'mesh', livekit: null };
  } catch { /* endpoint missing (older server) or offline: mesh */ }
  cache = { value, at: Date.now() };
  return value;
}

/** A short-lived room token for one voice channel. Throws the API error. */
export function fetchLivekitToken(channelId) {
  return post('/api/voice/livekit/token', { channelId });
}
