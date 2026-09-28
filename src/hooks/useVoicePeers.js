import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from '../api';
import { createAudioPlayback } from '../voice/playback';

/**
 * WebRTC full mesh for a voice channel.
 *
 * Every participant connects directly to every other one — N-1 peer connections
 * each. That is the right topology up to roughly 8 people; beyond that an SFU is
 * needed, because upstream bandwidth grows linearly with the room size.
 *
 * ---------------------------------------------------------------------------
 * Why fixed transceivers rather than addTrack/removeTrack
 * ---------------------------------------------------------------------------
 * Turning a camera on mid-call by calling addTrack() changes the set of media
 * sections, which requires a fresh offer/answer round trip. In a mesh that is
 * N-1 renegotiations racing each other, and any missed one leaves a peer who
 * can hear you but cannot see you.
 *
 * Instead the offerer creates four transceivers up front — mic, camera, screen
 * video, screen audio — all `sendrecv`. Their m-line order fixes their position
 * in getTransceivers() on both sides, so the answerer can map them to the same
 * roles. Toggling a camera is then just `sender.replaceTrack(track | null)`,
 * which needs no renegotiation at all and takes effect immediately.
 *
 * The answerer must upgrade the transceivers that setRemoteDescription created
 * for it: JSEP creates them `recvonly`, and replaceTrack() does not change the
 * direction — without the upgrade the answer says recvonly and that side of
 * every pair is never heard.
 */

// Used when the server offers no ICE configuration. STUN alone connects most
// home networks, but symmetric NATs, CGNAT (mobile) and strict corporate
// firewalls need a TURN relay — see DEPLOYMENT.md, "Voice and video: TURN".
const FALLBACK_ICE = (() => {
  try {
    const fromBuild = import.meta.env?.VITE_ICE_SERVERS;
    if (fromBuild) return { iceServers: JSON.parse(fromBuild) };
  } catch { /* malformed build variable: fall through to STUN */ }
  return { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
})();

// TURN REST credentials expire, so the configuration is re-fetched when it is
// older than this rather than once per page load.
const ICE_MAX_AGE_MS = 60 * 60 * 1000;
let iceCache = null;   // { config, at }

async function loadIceConfig() {
  if (iceCache && Date.now() - iceCache.at < ICE_MAX_AGE_MS) return iceCache.config;
  let config = FALLBACK_ICE;
  try {
    const remote = await get('/api/voice/ice-servers');
    if (Array.isArray(remote?.iceServers) && remote.iceServers.length) {
      config = {
        iceServers: remote.iceServers,
        ...(remote.iceTransportPolicy === 'relay' ? { iceTransportPolicy: 'relay' } : {})
      };
    }
  } catch { /* endpoint not deployed: STUN (or the build-time list) it is */ }
  iceCache = { config, at: Date.now() };
  return config;
}

// Transceiver position → what that media section carries.
const ROLES = ['audio', 'camera', 'screen', 'screenAudio'];
const roleOf = (pc, transceiver) => ROLES[pc.getTransceivers().indexOf(transceiver)] ?? null;

const MAX_ICE_RESTARTS = 3;
const DISCONNECTED_GRACE_MS = 4000;

export function useVoicePeers({
  socket,
  tracks = {},              // { audio, camera, screen, screenAudio } — MediaStreamTrack or null
  participants,
  selfUserId,
  enabled,
  volumes = {},
  localMutes = {},          // userId -> true when this listener muted them
  isDeafened = false,
  outputVolume = 100,
  outputDeviceId = 'default',
  attenuation = 0,          // % to duck others by while someone shares or speaks
  attenuateWhileSpeaking = false,
  selfSpeaking = false,
  spatialAudio = false,     // place each speaker left/right by their tile
  positions = {}            // userId -> -1 (hard left) … 1 (hard right)
}) {
  // Playback settings are read through a ref so moving a volume slider does not
  // invalidate attachRemoteTrack → createPeer → the mesh effect, which would
  // re-run the whole reconciliation loop on every drag.
  const playbackRef = useRef({});
  playbackRef.current = {
    volumes, localMutes, isDeafened, outputVolume, outputDeviceId,
    attenuation, attenuateWhileSpeaking, selfSpeaking, spatialAudio, positions
  };

  const peersRef = useRef(new Map());        // socketId -> { pc, userId, senders, polite, makingOffer, ignoreOffer, restarts }
  const pendingCandidatesRef = useRef(new Map());   // socketId -> RTCIceCandidateInit[]
  // Remote audio: `${socketId}` | `${socketId}:screen` -> <audio> (+ Web Audio graph when needed).
  const playbackRef_ = useRef(null);
  if (!playbackRef_.current) playbackRef_.current = createAudioPlayback(() => playbackRef.current);
  const playback = playbackRef_.current;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const participantsRef = useRef(participants);
  participantsRef.current = participants;
  const iceRef = useRef(null);

  const [iceReady, setIceReady] = useState(false);
  const [peerStates, setPeerStates] = useState({});    // socketId -> connectionState
  const [remoteMedia, setRemoteMedia] = useState({});  // userId -> { camera, screen }

  const selfSocketId = socket?.id ?? null;

  const setState = useCallback((socketId, state) => {
    setPeerStates((prev) => (prev[socketId] === state ? prev : { ...prev, [socketId]: state }));
  }, []);

  const userIdFor = (socketId) =>
    participantsRef.current?.find((p) => p.socketId === socketId)?.userId ?? null;

  const detachAudio = useCallback((key) => playback.detach(key), [playback]);
  const attachRemoteAudio = useCallback(
    (key, userId, stream) => playback.attach(key, userId, stream),
    [playback]
  );

  const setRemoteVideo = useCallback((userId, role, stream) => {
    if (!userId) return;
    setRemoteMedia((prev) => {
      const current = prev[userId] ?? {};
      if (current[role] === stream) return prev;
      return { ...prev, [userId]: { ...current, [role]: stream } };
    });
  }, []);

  const closePeer = useCallback((socketId) => {
    const peer = peersRef.current.get(socketId);
    if (peer) {
      clearTimeout(peer.disconnectTimer);
      peer.pc.ontrack = null;
      peer.pc.onicecandidate = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.onnegotiationneeded = null;
      try { peer.pc.close(); } catch { /* already closed */ }
      peersRef.current.delete(socketId);
      if (peer.userId) {
        setRemoteMedia((prev) => {
          if (!(peer.userId in prev)) return prev;
          const next = { ...prev };
          delete next[peer.userId];
          return next;
        });
      }
    }
    pendingCandidatesRef.current.delete(socketId);
    detachAudio(socketId);
    detachAudio(`${socketId}:screen`);
    setPeerStates((prev) => {
      if (!(socketId in prev)) return prev;
      const next = { ...prev };
      delete next[socketId];
      return next;
    });
  }, [detachAudio]);

  /** Point this peer's senders at whatever we are currently capturing. */
  const syncSenders = useCallback((peer) => {
    if (!peer?.senders) return;
    const current = tracksRef.current;
    for (const role of ROLES) {
      const sender = peer.senders[role];
      if (!sender) continue;
      const wanted = current[role] ?? null;
      if (sender.track === wanted) continue;
      sender.replaceTrack(wanted).catch(() => {});
    }
  }, []);

  /** Candidates that arrived before the remote description could take them. */
  const flushCandidates = useCallback(async (socketId, pc) => {
    const queued = pendingCandidatesRef.current.get(socketId);
    if (!queued?.length) return;
    pendingCandidatesRef.current.delete(socketId);
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch { /* stale after a restart */ }
    }
  }, []);

  const createPeer = useCallback((socketId, userId, { isOfferer }) => {
    const existing = peersRef.current.get(socketId);
    if (existing) {
      if (userId && !existing.userId) existing.userId = userId;
      return existing;
    }

    const pc = new RTCPeerConnection(iceRef.current ?? FALLBACK_ICE);
    const peer = {
      pc,
      userId: userId ?? userIdFor(socketId),
      senders: {},
      // Exactly one side is polite; on a collision the polite peer rolls back.
      polite: selfSocketId ? selfSocketId > socketId : true,
      makingOffer: false,
      ignoreOffer: false,
      restarts: 0,
      disconnectTimer: null
    };
    peersRef.current.set(socketId, peer);

    // The offerer defines the m-line order that both sides map roles from.
    if (isOfferer) {
      peer.senders.audio = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      peer.senders.camera = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      peer.senders.screen = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      peer.senders.screenAudio = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      syncSenders(peer);
    }

    pc.ontrack = (event) => {
      const role = roleOf(pc, event.transceiver) ?? (event.track.kind === 'audio' ? 'audio' : 'camera');
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      if (!peer.userId) peer.userId = userIdFor(socketId);

      if (role === 'audio' || role === 'screenAudio') {
        attachRemoteAudio(role === 'audio' ? socketId : `${socketId}:screen`, peer.userId, stream);
        return;
      }

      // A muted (i.e. replaced-with-null) remote video track still fires
      // ontrack once; treat live/ended as the signal for whether to show it.
      // peer.userId is read at call time, so a late-learned id still works.
      const publish = () => setRemoteVideo(peer.userId, role, event.track.muted ? null : stream);
      publish();
      event.track.onunmute = publish;
      event.track.onmute = () => setRemoteVideo(peer.userId, role, null);
      event.track.onended = () => setRemoteVideo(peer.userId, role, null);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc_ice_candidate', { targetSocketId: socketId, candidate: event.candidate });
      }
    };

    // Recover rather than give up: a network change (Wi-Fi → mobile, VPN on)
    // kills the selected candidate pair, and an ICE restart finds a new one
    // without tearing down the transceivers. restartIce() fires
    // negotiationneeded, so perfect negotiation carries the new offer.
    const restart = () => {
      if (pc.signalingState === 'closed' || peer.restarts >= MAX_ICE_RESTARTS) return;
      peer.restarts += 1;
      if (pc.restartIce) pc.restartIce();
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setState(socketId, state);
      clearTimeout(peer.disconnectTimer);
      if (state === 'connected') peer.restarts = 0;
      else if (state === 'failed') restart();
      else if (state === 'disconnected') {
        // Often transient; only restart if it does not come back by itself.
        peer.disconnectTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') restart();
        }, DISCONNECTED_GRACE_MS);
      }
    };

    // Perfect negotiation: whichever side needs a new offer makes one, and a
    // collision is resolved by politeness rather than by luck.
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit('webrtc_offer', { targetSocketId: socketId, offer: pc.localDescription });
      } catch (err) {
        console.warn('negotiation failed:', err.message);
      } finally {
        peer.makingOffer = false;
      }
    };

    return peer;
  }, [socket, selfSocketId, attachRemoteAudio, setState, setRemoteVideo, syncSenders]);

  // --- ICE configuration ----------------------------------------------------
  // Fetched on every join so short-lived TURN credentials are fresh.
  useEffect(() => {
    if (!enabled) { setIceReady(false); return undefined; }
    let cancelled = false;
    loadIceConfig().then((config) => {
      if (cancelled) return;
      iceRef.current = config;
      setIceReady(true);
    });
    return () => { cancelled = true; };
  }, [enabled]);

  // --- signalling ------------------------------------------------------------

  useEffect(() => {
    if (!socket || !enabled) return undefined;

    const onOffer = async ({ senderSocketId, offer }) => {
      // An offer can beat our own ICE fetch; wait for it rather than build a
      // connection that has no TURN server.
      if (!iceRef.current) iceRef.current = await loadIceConfig();
      const peer = peersRef.current.get(senderSocketId)
        ?? createPeer(senderSocketId, null, { isOfferer: false });
      const { pc } = peer;
      try {
        const collision = peer.makingOffer || pc.signalingState !== 'stable';
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(offer);

        // The answerer inherits the offerer's transceivers; map them to roles
        // by m-line order, upgrade them from the recvonly JSEP gave us, and
        // attach our own tracks to the same sections.
        for (const transceiver of pc.getTransceivers()) {
          const role = roleOf(pc, transceiver);
          if (!role) continue;
          peer.senders[role] = transceiver.sender;
          if (transceiver.direction === 'recvonly') transceiver.direction = 'sendrecv';
        }
        syncSenders(peer);

        await pc.setLocalDescription();
        socket.emit('webrtc_answer', { targetSocketId: senderSocketId, answer: pc.localDescription });
        await flushCandidates(senderSocketId, pc);
      } catch (err) {
        console.warn('webrtc offer handling failed:', err.message);
      }
    };

    const onAnswer = async ({ senderSocketId, answer }) => {
      const peer = peersRef.current.get(senderSocketId);
      if (!peer) return;
      try {
        if (peer.pc.signalingState !== 'have-local-offer') return;   // duplicate
        await peer.pc.setRemoteDescription(answer);
        await flushCandidates(senderSocketId, peer.pc);
      } catch (err) {
        console.warn('webrtc answer handling failed:', err.message);
      }
    };

    const onCandidate = async ({ senderSocketId, candidate }) => {
      if (!candidate) return;
      const peer = peersRef.current.get(senderSocketId);
      // Trickled candidates can overtake the description they belong to (or
      // arrive while we are still fetching ICE config). Dropping them can
      // leave a pair with no working route, so hold them until it is set.
      if (!peer || !peer.pc.remoteDescription) {
        const queue = pendingCandidatesRef.current.get(senderSocketId) ?? [];
        if (queue.length < 100) queue.push(candidate);
        pendingCandidatesRef.current.set(senderSocketId, queue);
        return;
      }
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (err) {
        if (!peer.ignoreOffer) console.warn('ICE candidate rejected:', err.message);
      }
    };

    socket.on('webrtc_offer', onOffer);
    socket.on('webrtc_answer', onAnswer);
    socket.on('webrtc_ice_candidate', onCandidate);
    return () => {
      socket.off('webrtc_offer', onOffer);
      socket.off('webrtc_answer', onAnswer);
      socket.off('webrtc_ice_candidate', onCandidate);
    };
  }, [socket, enabled, createPeer, syncSenders, flushCandidates]);

  // --- mesh maintenance -----------------------------------------------------

  // A socket reconnect gives us a new id. Every connection built under the old
  // one is dead on the far side (the server dropped that socket), and the
  // politeness roles were derived from it — start over.
  const lastSelfSocketRef = useRef(selfSocketId);
  useEffect(() => {
    if (lastSelfSocketRef.current === selfSocketId) return;
    lastSelfSocketRef.current = selfSocketId;
    for (const socketId of [...peersRef.current.keys()]) closePeer(socketId);
  }, [selfSocketId, closePeer]);

  useEffect(() => {
    if (!socket || !enabled || !selfSocketId || !iceReady) return;

    const others = participants.filter(
      (p) => p.socketId && p.socketId !== selfSocketId && p.userId !== selfUserId
    );
    const wanted = new Set(others.map((p) => p.socketId));

    for (const socketId of [...peersRef.current.keys()]) {
      if (!wanted.has(socketId)) closePeer(socketId);
    }

    for (const other of others) {
      const known = peersRef.current.get(other.socketId);
      if (known) {
        // Learn the user id if the peer connected before the roster caught up.
        if (!known.userId && other.userId) {
          known.userId = other.userId;
          for (const key of [other.socketId, `${other.socketId}:screen`]) playback.setUser(key, other.userId);
        }
        continue;
      }
      // Only the lexicographically smaller socket id opens the connection, so
      // both sides never build one at the same time.
      if (!(selfSocketId < other.socketId)) continue;
      createPeer(other.socketId, other.userId, { isOfferer: true });
      // onnegotiationneeded fires from the transceivers we just added.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, enabled, participants, selfSocketId, selfUserId, iceReady, createPeer, closePeer]);

  // Camera and screen toggles are just a track swap — no renegotiation.
  useEffect(() => {
    for (const [, peer] of peersRef.current) syncSenders(peer);
  }, [tracks.audio, tracks.camera, tracks.screen, tracks.screenAudio, syncSenders]);

  // Apply playback changes without rebuilding anything.
  const positionsKey = JSON.stringify(positions);
  useEffect(() => {
    playback.applyAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumes, localMutes, isDeafened, outputVolume, outputDeviceId, attenuation, attenuateWhileSpeaking, selfSpeaking, spatialAudio, positionsKey]);

  // Leaving voice must actually close every connection and audio context, not
  // just stop reconciling — an open RTCPeerConnection keeps sending.
  const closeAll = useCallback(() => {
    for (const socketId of [...peersRef.current.keys()]) closePeer(socketId);
    pendingCandidatesRef.current.clear();
    playback.closeAll();
  }, [closePeer, playback]);

  useEffect(() => {
    if (enabled) return;
    closeAll();
    setPeerStates({});
    setRemoteMedia({});
  }, [enabled, closeAll]);

  useEffect(() => () => closeAll(), [closeAll]);

  // Connection quality per peer, from the selected candidate pair's round-trip
  // time and inbound packet loss — the same signals LiveKit grades on.
  const [quality, setQuality] = useState({});   // userId -> excellent|good|poor|lost
  useEffect(() => {
    if (!enabled) { setQuality({}); return undefined; }
    const previous = new Map();   // socketId -> { lost, received }
    const timer = setInterval(async () => {
      const next = {};
      for (const [socketId, peer] of peersRef.current) {
        if (!peer.userId) continue;
        const state = peer.pc.connectionState;
        if (state === 'failed' || state === 'disconnected') { next[peer.userId] = 'lost'; continue; }
        if (state !== 'connected') continue;
        try {
          const stats = await peer.pc.getStats();
          let rtt = null; let lost = 0; let received = 0;
          stats.forEach((r) => {
            if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
            if (r.type === 'inbound-rtp' && r.kind === 'audio') { lost += r.packetsLost ?? 0; received += r.packetsReceived ?? 0; }
          });
          const before = previous.get(socketId) ?? { lost: 0, received: 0 };
          previous.set(socketId, { lost, received });
          const dLost = Math.max(0, lost - before.lost);
          const dTotal = dLost + Math.max(0, received - before.received);
          const loss = dTotal ? dLost / dTotal : 0;
          next[peer.userId] = loss > 0.05 || (rtt ?? 0) > 0.4 ? 'poor'
            : loss > 0.01 || (rtt ?? 0) > 0.15 ? 'good' : 'excellent';
        } catch { /* closed mid-poll */ }
      }
      setQuality((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    }, 3000);
    return () => clearInterval(timer);
  }, [enabled]);

  const states = Object.values(peerStates);
  const connectionState = !enabled ? 'idle'
    : states.some((st) => st === 'disconnected' || st === 'failed') ? 'reconnecting'
    : states.every((st) => st === 'connected') ? 'connected' : 'connecting';

  return {
    peerStates,
    remoteMedia,
    quality,
    connectionState,
    peerCount: Object.keys(peerStates).length,
    connectedCount: Object.values(peerStates).filter((s) => s === 'connected').length,
    resumeAudio: () => playback.resume()
  };
}
