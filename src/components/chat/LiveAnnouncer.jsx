import React, { useEffect, useRef, useState } from 'react';
import { subscribeAnnouncements } from '../../chat/announcer';

/**
 * The app's single pair of live regions, mounted once and never unmounted
 * (see src/chat/announcer.js). Announcements that arrive together are joined
 * into one utterance; a repeat of the same text is still spoken, by clearing
 * the region for a moment first.
 */
export default function LiveAnnouncer() {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const queue = useRef({ polite: [], assertive: [] });
  const timers = useRef({});

  useEffect(() => {
    const flush = (kind) => {
      const items = queue.current[kind];
      queue.current[kind] = [];
      timers.current[kind] = null;
      if (!items.length) return;
      const text = items.join('. ');
      const set = kind === 'assertive' ? setAssertive : setPolite;
      set('');
      // A tick of empty content makes screen readers treat the next value as
      // a change even when it repeats the previous one.
      timers.current[`${kind}Set`] = setTimeout(() => set(text), 60);
      clearTimeout(timers.current[`${kind}Clear`]);
      timers.current[`${kind}Clear`] = setTimeout(() => set(''), 8000);
    };
    const unsubscribe = subscribeAnnouncements(({ text, assertive: urgent }) => {
      const kind = urgent ? 'assertive' : 'polite';
      if (!queue.current[kind].includes(text)) queue.current[kind].push(text);
      if (!timers.current[kind]) timers.current[kind] = setTimeout(() => flush(kind), 150);
    });
    const pending = timers.current;
    return () => {
      unsubscribe();
      for (const id of Object.values(pending)) clearTimeout(id);
    };
  }, []);

  return (
    <div className="sr-only" data-focus-trap-ignore>
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="live-announcer">{polite}</div>
      <div role="alert" aria-live="assertive" aria-atomic="true">{assertive}</div>
    </div>
  );
}
