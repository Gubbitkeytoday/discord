import { useCallback, useEffect, useRef, useState } from 'react';

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
 * Instead the offerer creates three transceivers up front — audio, camera,
 * screen — all `sendrecv`. Their m-line order fixes their `mid` values ("0",
 * "1", "2") for both sides, so the answerer can map them to the same roles.
 * Toggling a camera is then just `sender.replaceTrack(track | null)`, which
 * needs no renegotiation at all and takes effect immediately.
 */

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];

// m-line index → what that media section carries.
const ROLE_BY_MID = { 0: 'audio', 1: 'camera', 2: 'screen' };

export function useVoicePeers({
  socket,
  tracks = {},              // { audio, camera, screen } — MediaStreamTrack or null
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
  selfSpeaking = false
}) {
  // Playback settings are read through a ref so moving a volume slider does not
  // invalidate attachRemoteTrack → createPeer → the mesh effect, which would
  // re-run the whole reconciliation loop on every drag.
  const playbackRef = useRef({});
  playbackRef.current = {
    volumes, localMutes, isDeafened, outputVolume, outputDeviceId,
    attenuation, attenuateWhileSpeaking, selfSpeaking
  };

  const peersRef = useRef(new Map());        // socketId -> { pc, userId, senders, polite, makingOffer, ignoreOffer }
  const audioNodesRef = useRef(new Map());   // socketId -> { el, gain, ctx, source, userId }
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  const [peerStates, setPeerStates] = useState({});    // socketId -> connectionState
  const [remoteMedia, setRemoteMedia] = useState({});  // userId -> { camera, screen }

  const selfSocketId = socket?.id ?? null;

  const setState = useCallback((socketId, state) => {
    setPeerStates((prev) => (prev[socketId] === state ? prev : { ...prev, [socketId]: state }));
  }, []);

  /** Deafen silences everyone; per-user volume, master volume and attenuation multiply on top. */
  function applyPlayback(node, userId) {
    const p = playbackRef.current;
    if (!node?.gain) return;
    const ducked = p.attenuateWhileSpeaking && p.selfSpeaking ? 1 - (p.attenuation / 100) : 1;
    const silenced = p.isDeafened || p.localMutes[userId];
    const percent = p.volumes[userId] ?? 100;
    node.gain.gain.value = silenced ? 0 : (percent / 100) * (p.outputVolume / 100) * ducked;
    // Route playback to the chosen speaker where the browser supports it.
    if (p.outputDeviceId && p.outputDeviceId !== 'default' && node.el.setSinkId) {
      node.el.setSinkId(p.outputDeviceId).catch(() => {});
    }
  }

  /**
   * Route a remote audio track through a GainNode so per-user volume works.
   * Setting <audio>.volume caps at 1.0; Discord allows boosting past 100%,
   * which needs Web Audio.
   */
  const attachRemoteAudio = useCallback((socketId, userId, stream) => {
    let node = audioNodesRef.current.get(socketId);
    if (!node) {
      const el = new Audio();
      el.autoplay = true;
      el.muted = true;             // playback happens through the audio graph
      el.srcObject = stream;
      el.play().catch(() => {});   // some browsers need this to pump the stream

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      source.connect(gain).connect(ctx.destination);

      node = { el, ctx, gain, source, userId };
      audioNodesRef.current.set(socketId, node);
    } else {
      node.el.srcObject = stream;
      node.userId = userId;
    }
    applyPlayback(node, userId);
  }, []);

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
    const node = audioNodesRef.current.get(socketId);
    if (node) {
      node.el.srcObject = null;
      node.source.disconnect();
      node.gain.disconnect();
      node.ctx.close().catch(() => {});
      audioNodesRef.current.delete(socketId);
    }
    setPeerStates((prev) => {
      if (!(socketId in prev)) return prev;
      const next = { ...prev };
      delete next[socketId];
      return next;
    });
  }, []);

  /** Point this peer's three senders at whatever we are currently capturing. */
  const syncSenders = useCallback((peer) => {
    if (!peer?.senders) return;
    const current = tracksRef.current;
    for (const role of ['audio', 'camera', 'screen']) {
      const sender = peer.senders[role];
      if (!sender) continue;
      const wanted = current[role] ?? null;
      if (sender.track === wanted) continue;
      sender.replaceTrack(wanted).catch(() => {});
    }
  }, []);

  const createPeer = useCallback((socketId, userId, { isOfferer }) => {
    const existing = peersRef.current.get(socketId);
    if (existing) {
      if (userId && !existing.userId) existing.userId = userId;
      return existing;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = {
      pc,
      userId: userId ?? null,
      senders: {},
      // Exactly one side is polite; on a collision the polite peer rolls back.
      polite: selfSocketId ? selfSocketId > socketId : true,
      makingOffer: false,
      ignoreOffer: false
    };
    peersRef.current.set(socketId, peer);

    // The offerer defines the m-line order that both sides map roles from.
    if (isOfferer) {
      peer.senders.audio = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      peer.senders.camera = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      peer.senders.screen = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      syncSenders(peer);
    }

    pc.ontrack = (event) => {
      const role = ROLE_BY_MID[Number(event.transceiver?.mid)] ?? (event.track.kind === 'audio' ? 'audio' : 'camera');
      const stream = event.streams[0] ?? new MediaStream([event.track]);

      if (role === 'audio') {
        attachRemoteAudio(socketId, peer.userId, stream);
        return;
      }

      // A muted (i.e. replaced-with-null) remote video track still fires
      // ontrack once; treat live/ended as the signal for whether to show it.
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

    pc.onconnectionstatechange = () => {
      setState(socketId, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(socketId);
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
  }, [socket, selfSocketId, attachRemoteAudio, closePeer, setState, setRemoteVideo, syncSenders]);

  // --- signalling ------------------------------------------------------------

  useEffect(() => {
    if (!socket || !enabled) return undefined;

    const onOffer = async ({ senderSocketId, offer }) => {
      const peer = peersRef.current.get(senderSocketId)
        ?? createPeer(senderSocketId, null, { isOfferer: false });
      const { pc } = peer;
      try {
        const collision = peer.makingOffer || pc.signalingState !== 'stable';
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        // The answerer inherits the offerer's transceivers; map them to roles
        // by m-line order and attach our own tracks to the same sections.
        if (!peer.senders.audio) {
          for (const transceiver of pc.getTransceivers()) {
            const role = ROLE_BY_MID[Number(transceiver.mid)];
            if (role) peer.senders[role] = transceiver.sender;
          }
        }
        syncSenders(peer);

        await pc.setLocalDescription();
        socket.emit('webrtc_answer', { targetSocketId: senderSocketId, answer: pc.localDescription });
      } catch (err) {
        console.warn('webrtc offer handling failed:', err.message);
      }
    };

    const onAnswer = async ({ senderSocketId, answer }) => {
      const peer = peersRef.current.get(senderSocketId);
      if (!peer) return;
      try {
        if (peer.pc.signalingState !== 'have-local-offer') return;   // duplicate
        await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.warn('webrtc answer handling failed:', err.message);
      }
    };

    const onCandidate = async ({ senderSocketId, candidate }) => {
      const peer = peersRef.current.get(senderSocketId);
      if (!peer || !candidate) return;
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        // Candidates that arrive before the remote description, or for an
        // offer we deliberately ignored, are expected.
        if (!peer.ignoreOffer && peer.pc.remoteDescription) {
          console.warn('ICE candidate rejected:', err.message);
        }
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
  }, [socket, enabled, createPeer, syncSenders]);

  // --- mesh maintenance -----------------------------------------------------

  useEffect(() => {
    if (!socket || !enabled || !selfSocketId) return;

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
        if (!known.userId && other.userId) known.userId = other.userId;
        continue;
      }
      // Only the lexicographically smaller socket id opens the connection, so
      // both sides never build one at the same time.
      if (!(selfSocketId < other.socketId)) continue;
      createPeer(other.socketId, other.userId, { isOfferer: true });
      // onnegotiationneeded fires from the transceivers we just added.
    }
  }, [socket, enabled, participants, selfSocketId, selfUserId, createPeer, closePeer]);

  // Camera and screen toggles are just a track swap — no renegotiation.
  useEffect(() => {
    for (const [, peer] of peersRef.current) syncSenders(peer);
  }, [tracks.audio, tracks.camera, tracks.screen, syncSenders]);

  // Apply playback changes without rebuilding anything.
  useEffect(() => {
    for (const [, node] of audioNodesRef.current) applyPlayback(node, node.userId);
  }, [volumes, localMutes, isDeafened, outputVolume, outputDeviceId, attenuation, attenuateWhileSpeaking, selfSpeaking]);

  // Leaving voice must actually close every connection and audio context, not
  // just stop reconciling — an open RTCPeerConnection keeps sending.
  useEffect(() => {
    if (enabled) return;
    for (const socketId of [...peersRef.current.keys()]) closePeer(socketId);
    setPeerStates({});
    setRemoteMedia({});
  }, [enabled, closePeer]);

  useEffect(() => () => {
    for (const socketId of [...peersRef.current.keys()]) closePeer(socketId);
  }, [closePeer]);

  return {
    peerStates,
    remoteMedia,
    peerCount: Object.keys(peerStates).length,
    connectedCount: Object.values(peerStates).filter((s) => s === 'connected').length
  };
}
