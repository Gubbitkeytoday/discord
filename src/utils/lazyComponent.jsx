import React, { Component, Suspense, lazy } from 'react';

/**
 * A failed chunk download (flaky network, a deploy replaced the files) must
 * not take the whole app down: the surface simply does not open, and the next
 * attempt retries the download.
 */
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|Loading chunk|Loading CSS chunk|ChunkLoadError/i;
export const isChunkLoadError = (error) =>
  error?.name === 'ChunkLoadError' || CHUNK_ERROR.test(String(error?.message ?? ''));

class ChunkBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    if (!isChunkLoadError(error)) return;
    console.error('Failed to load a part of the app:', error);
    this.props.onError?.();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Only a failed download is swallowed here. A render error inside the
    // loaded component goes on up to the nearest ErrorBoundary, which can
    // say so and offer a retry instead of the surface silently vanishing.
    if (!isChunkLoadError(error)) throw error;
    return null;
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
