import { useCallback, useEffect, useRef, useState } from 'react';

// ============================================================================
//  Gateway connection state for the "Connection lost — reconnecting" banner,
//  and the trigger for REST catch-up after a reconnect that did not recover.
//
//    status: 'connected'     all good (also before the first connect)
//            'draining'      the server said it is restarting (server_draining);
//                            we reconnect ourselves after retry_after_ms
//            'reconnecting'  the connection dropped; socket.io is retrying
//            'offline'       the browser reports no network at all
//
//  After a reconnect, `socket.recovered === true` means Socket.IO replayed the
//  missed events and there is nothing to do. Otherwise `onResync` runs once
//  the gateway has re-identified us (so rooms are re-joined first and nothing
//  lands in the gap between the REST read and the join). See routes/sync.js.
// ============================================================================

// A blip shorter than this never shows the banner.
const BANNER_GRACE_MS = 1500;
// socket.io does not auto-reconnect after a server-side disconnect
// ("io server disconnect"); these are the waits before we do it ourselves.
const SERVER_DISCONNECT_RETRY_MS = 2000;
const RATE_LIMITED_RETRY_MS = 5000;

export function useRealtimeConnection(socket, { enabled, onResync, onRateLimited } = {}) {
  const [status, setStatus] = useState('connected');
  const [visible, setVisible] = useState(false);
  const dropped = useRef(false);        // an unexpected disconnect since the last connect
  const needsResync = useRef(false);
  const draining = useRef(null);       // retry_after_ms while a drain is under way
  const rateLimited = useRef(false);
  const timers = useRef(new Set());
  const onResyncRef = useRef(onResync);
  onResyncRef.current = onResync;
  const onRateLimitedRef = useRef(onRateLimited);
  onRateLimitedRef.current = onRateLimited;

  const later = useCallback((fn, ms) => {
    const id = setTimeout(() => { timers.current.delete(id); fn(); }, ms);
    timers.current.add(id);
  }, []);
  const clearTimers = useCallback(() => {
    for (const id of timers.current) clearTimeout(id);
    timers.current.clear();
  }, []);

  /** "Retry now": skip whatever backoff socket.io is waiting out. */
  const retry = useCallback(() => {
    if (socket.connected) return;
    try { socket.connect(); } catch { /* the manager retries on its own */ }
  }, [socket]);

  useEffect(() => {
    if (!enabled) {
      setStatus('connected');
      setVisible(false);
      return undefined;
    }

    const setAutoReconnect = (on) => { try { socket.io?.reconnection?.(on); } catch { /* older client */ } };

    const onConnect = () => {
      clearTimers();
      setAutoReconnect(true);
      draining.current = null;
      rateLimited.current = false;
      setStatus('connected');
      setVisible(false);
      // Only a drop we did not ask for needs catching up; re-opening the
      // socket ourselves (sign-in) is followed by a full load anyway.
      if (dropped.current && !socket.recovered) needsResync.current = true;
      dropped.current = false;
    };

    const onIdentified = () => {
      if (!needsResync.current) return;
      needsResync.current = false;
      Promise.resolve(onResyncRef.current?.()).catch((err) => console.error('catch-up sync failed:', err));
    };

    const onDisconnect = (reason) => {
      // We closed it ourselves (sign-out, or re-opening with a new cookie).
      if (reason === 'io client disconnect') return;
      dropped.current = true;
      const drain = draining.current;
      setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline'
        : drain !== null ? 'draining' : 'reconnecting');
      if (drain !== null) setVisible(true);
      else later(() => { if (!socket.connected) setVisible(true); }, BANNER_GRACE_MS);
      if (reason === 'io server disconnect' && drain === null) {
        later(() => { if (!socket.connected) retry(); }, rateLimited.current ? RATE_LIMITED_RETRY_MS : SERVER_DISCONNECT_RETRY_MS);
      }
    };

    // Graceful restart/deploy: the server asks us to come back after a random
    // delay so every client does not reconnect in the same instant.
    const onDraining = (payload = {}) => {
      const wait = Math.max(0, Math.min(30_000, Number(payload.retry_after_ms) || 1000));
      draining.current = wait;
      setStatus('draining');
      setVisible(true);
      if (payload.reconnect === false) return;
      // Hold socket.io's own backoff until the server's delay has passed,
      // then reconnect; from there the manager's normal retry loop takes over
      // if the new instance is not up yet.
      setAutoReconnect(false);
      later(() => {
        setAutoReconnect(true);
        if (!socket.connected) retry();
      }, wait);
    };

    const onRateLimitedEvent = (payload) => {
      rateLimited.current = true;
      onRateLimitedRef.current?.(payload);
    };

    const onOffline = () => {
      if (socket.connected) return;
      setStatus('offline');
      setVisible(true);
    };
    const onOnline = () => {
      if (!socket.connected) { setStatus('reconnecting'); retry(); }
    };

    socket.on('connect', onConnect);
    socket.on('identified', onIdentified);
    socket.on('disconnect', onDisconnect);
    socket.on('server_draining', onDraining);
    socket.on('rate_limited', onRateLimitedEvent);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      clearTimers();
      setAutoReconnect(true);
      socket.off('connect', onConnect);
      socket.off('identified', onIdentified);
      socket.off('disconnect', onDisconnect);
      socket.off('server_draining', onDraining);
      socket.off('rate_limited', onRateLimitedEvent);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [socket, enabled, later, clearTimers, retry]);

  return { status, showBanner: enabled && visible && status !== 'connected', retry };
}
