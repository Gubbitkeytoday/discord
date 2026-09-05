import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { initPreferences } from './hooks/useUserSettings';
import { I18nProvider, initLocale } from './i18n/index.jsx';
import './index.css';

// Apply the cached appearance and accessibility preferences before React
// mounts, so the app never flashes the wrong theme, zoom or contrast.
initPreferences();
// Same idea for <html lang>: set it before the first paint so assistive tech and
// hyphenation are correct from the start.
initLocale();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
);
