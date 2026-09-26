import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { initPreferences } from './hooks/useUserSettings';
import { I18nProvider, initLocale } from './i18n/index.jsx';
import { DEFAULT_AVATAR } from './utils/avatar';
import './index.css';

// Apply the cached appearance and accessibility preferences before React
// mounts, so the app never flashes the wrong theme, zoom or contrast.
initPreferences();
// Same idea for <html lang>: set it before the first paint so assistive tech and
// hyphenation are correct from the start.
initLocale();

// Avatars come from user-supplied URLs that rot, get hot-link blocked, or are
// unreachable behind a firewall; each one left the browser's broken-image
// glyph in the member list, DMs and every message. Rather than thread an
// onError through ~50 image sites, one capturing listener swaps any failed
// round image (avatars are always `rounded-full`) for the inline default.
// `error` does not bubble, hence the capture phase.
document.addEventListener('error', (event) => {
  const img = event.target;
  if (img?.tagName !== 'IMG') return;
  if (!img.classList.contains('rounded-full') || img.dataset.avatarFallback) return;
  img.dataset.avatarFallback = '1';
  img.src = DEFAULT_AVATAR;
}, true);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
);
