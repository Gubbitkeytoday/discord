// ============================================================================
//  Remote audio playback, shared by both voice backends (mesh and LiveKit).
//
//  Deafen silences everyone; per-user volume, local mute, master volume and
//  attenuation multiply on top; spatial audio pans each voice by tile.
//
//  Playback goes through a plain <audio> element whenever it can. Chrome's echo
//  canceller only uses audio played that way as its reference — audio routed
//  through Web Audio is invisible to it, so a speaker user's room would hear
//  itself echo back. The Web Audio graph is built only when it is really
//  needed: boosting someone past 100%, or spatial positioning.
// ============================================================================

/**
 * @param {() => object} getSettings returns the current playback settings:
 *   { volumes, localMutes, isDeafened, outputVolume, outputDeviceId,
 *     attenuation, attenuateWhileSpeaking, selfSpeaking, spatialAudio, positions }
 */
export function createAudioPlayback(getSettings) {
  const nodes = new Map();   // key -> { el, stream, userId, gain?, panner?, source? }
  let ctx = null;

  /** One AudioContext for every remote voice — browsers cap how many may exist. */
  function context() {
    if (!ctx || ctx.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtx();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function apply(node) {
    const p = getSettings() ?? {};
    if (!node?.el) return;
    const userId = node.userId;
    const volumes = p.volumes ?? {};
    const localMutes = p.localMutes ?? {};
    const outputVolume = p.outputVolume ?? 100;
    const ducked = p.attenuateWhileSpeaking && p.selfSpeaking ? 1 - ((p.attenuation ?? 0) / 100) : 1;
    const silenced = p.isDeafened || (userId && localMutes[userId]);
    const percent = (userId && volumes[userId]) ?? 100;
    const level = silenced ? 0 : (percent / 100) * (outputVolume / 100) * ducked;
    const needGraph = level > 1 || p.spatialAudio;
    const sink = p.outputDeviceId && p.outputDeviceId !== 'default' ? p.outputDeviceId : '';

    if (needGraph) {
      if (!node.gain) {
        const c = context();
        node.source = c.createMediaStreamSource(node.stream);
        node.gain = c.createGain();
        // The panner is always in the graph; with spatial audio off it sits at
        // the origin, which is indistinguishable from not having one.
        node.panner = c.createPanner();
        node.panner.panningModel = 'HRTF';
        node.panner.distanceModel = 'inverse';
        node.panner.refDistance = 1;
        node.panner.maxDistance = 4;
        node.source.connect(node.gain).connect(node.panner).connect(c.destination);
      }
      // The element keeps pumping the stream (Chrome needs that for the graph
      // to receive samples) but no longer plays it itself.
      node.el.muted = true;
      node.gain.gain.value = level;
      const positions = p.positions ?? {};
      const x = p.spatialAudio ? Math.max(-1, Math.min(1, Number(positions[userId] ?? 0))) : 0;
      const when = ctx.currentTime;
      // setValueAtTime rather than assignment: a jump in position clicks.
      node.panner.positionX?.setValueAtTime(x, when);
      node.panner.positionY?.setValueAtTime(0, when);
      node.panner.positionZ?.setValueAtTime(p.spatialAudio ? -0.4 : 0, when);
      if (ctx.setSinkId && ctx.sinkId !== sink) ctx.setSinkId(sink).catch(() => {});
    } else {
      if (node.gain) node.gain.gain.value = 0;
      node.el.volume = Math.max(0, Math.min(1, level));
      node.el.muted = level === 0;
      if (node.el.setSinkId && node.el.sinkId !== sink) node.el.setSinkId(sink).catch(() => {});
    }
    node.el.play().catch(() => {});
  }

  function detach(key) {
    const node = nodes.get(key);
    if (!node) return;
    node.el.pause();
    node.el.srcObject = null;
    try { node.source?.disconnect(); node.gain?.disconnect(); node.panner?.disconnect(); } catch { /* already gone */ }
    nodes.delete(key);
  }

  function attach(key, userId, stream) {
    let node = nodes.get(key);
    if (node && node.stream !== stream) { detach(key); node = null; }
    if (!node) {
      const el = new Audio();
      el.autoplay = true;
      el.srcObject = stream;
      node = { el, stream, userId };
      nodes.set(key, node);
    }
    if (userId) node.userId = userId;
    apply(node);
  }

  /** Learn the user behind an already-playing key (mesh: roster caught up late). */
  function setUser(key, userId) {
    const node = nodes.get(key);
    if (node && userId && node.userId !== userId) { node.userId = userId; apply(node); }
  }

  function applyAll() {
    for (const node of nodes.values()) apply(node);
  }

  /** Resume playback after a user gesture (autoplay policies). */
  function resume() {
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
    for (const node of nodes.values()) node.el.play().catch(() => {});
  }

  function closeAll() {
    for (const key of [...nodes.keys()]) detach(key);
    ctx?.close().catch(() => {});
    ctx = null;
  }

  return { attach, detach, setUser, applyAll, resume, closeAll, has: (key) => nodes.has(key) };
}
