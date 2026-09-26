import React, { Component, Suspense, lazy } from 'react';

/**
 * A failed chunk download (flaky network, a deploy replaced the files) must
 * not take the whole app down: the surface simply does not open, and the next
 * attempt retries the download.
 */
class ChunkBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('Failed to load a part of the app:', error);
    this.props.onError?.();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Code-split a component without touching its call sites: the returned
 * component renders the lazy one inside its own Suspense boundary. Heavy,
 * rarely-open surfaces (settings, forum, events, voice) live in their own
 * chunks so the first paint only downloads what the chat needs.
 *
 * `.preload()` starts the download early — called on idle after sign-in, so
 * opening the surface later is instant.
 */
export function lazyComponent(loader, fallback = null) {
  let promise = null;
  const load = () => {
    promise ??= loader().catch((error) => { promise = null; throw error; });
    return promise;
  };
  let Lazy = lazy(load);
  function LazyBoundary(props) {
    return (
      <ChunkBoundary onError={() => { Lazy = lazy(load); }}>
        <Suspense fallback={fallback}>
          <Lazy {...props} />
        </Suspense>
      </ChunkBoundary>
    );
  }
  LazyBoundary.preload = () => load().catch(() => {});
  return LazyBoundary;
}

/** Warm a list of lazy components when the browser is idle. */
export function preloadWhenIdle(components) {
  const run = () => components.forEach((c) => c.preload?.());
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}
