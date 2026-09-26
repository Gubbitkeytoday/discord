// ============================================================================
//  Screen-reader announcements for the call.
//
//  The app has one global live region (the announcer) that listens for a
//  window `app:announce` CustomEvent. Voice code only dispatches; it never owns
//  a live region of its own, so two regions cannot talk over each other.
// ============================================================================

/**
 * Ask the global announcer to read `message`. `politeness` is a hint the
 * announcer may honour ('polite' by default; 'assertive' for things the user
 * must hear right away, like losing the connection).
 */
export function announce(message, politeness = 'polite') {
  if (!message || typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('app:announce', { detail: { message, politeness } }));
  } catch { /* no CustomEvent: nothing to announce to */ }
}
