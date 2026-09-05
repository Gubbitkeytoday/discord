// ============================================================================
//  The two doors in front of a channel: age-restricted, and spoilers.
//
//  Both are the same shape — a full-pane interstitial the reader clicks
//  through — and both remember the answer per channel so the door is not in the
//  way every time the channel is opened. The memory is `localStorage`, i.e.
//  per person per browser, which is exactly the scope of "I have seen this
//  warning": it is a courtesy, not an access control. The real gate is the
//  permission check on the server.
// ============================================================================

import React, { useState } from 'react';
import { AlertTriangle, EyeOff } from 'lucide-react';
import { t } from '../i18n/index.jsx';

const KEY_PREFIX = 'antigravity.gate.';

function remembered(channelId, kind) {
  try { return window.localStorage.getItem(`${KEY_PREFIX}${kind}.${channelId}`) === '1'; }
  catch { return false; }               // private window, or storage blocked
}

function remember(channelId, kind) {
  try { window.localStorage.setItem(`${KEY_PREFIX}${kind}.${channelId}`, '1'); }
  catch { /* nothing to do; the gate simply reappears next time */ }
}

/**
 * Renders `children` once the reader has passed whichever gate applies.
 * A channel with neither flag renders straight through with no wrapper.
 */
export default function ChannelGate({ channel, onLeave, children }) {
  const kind = channel?.nsfw ? 'nsfw' : channel?.spoiler ? 'spoiler' : null;
  const [passed, setPassed] = useState(() => (kind ? remembered(channel.id, kind) : true));

  // Re-gate when the reader moves to a different restricted channel.
  const [lastId, setLastId] = useState(channel?.id);
  if (channel?.id !== lastId) {
    setLastId(channel?.id);
    setPassed(kind ? remembered(channel.id, kind) : true);
  }

  if (!kind || passed) return children;

  const enter = () => { remember(channel.id, kind); setPassed(true); };
  const Icon = kind === 'nsfw' ? AlertTriangle : EyeOff;

  return (
    <div className="flex-1 flex items-center justify-center p-8 bg-d-canvas">
      <div className="max-w-sm text-center" role="alertdialog" aria-labelledby="gate-title">
        <Icon className="w-12 h-12 mx-auto text-d-text4" aria-hidden="true" />
        <h2 id="gate-title" className="mt-4 text-lg font-bold text-d-strong">
          {kind === 'nsfw' ? t('chat.nsfwTitle') : t('chat.spoilerChannel')}
        </h2>
        {kind === 'nsfw' && <p className="mt-2 text-sm text-d-text3">{t('chat.nsfwBody')}</p>}
        <div className="mt-6 flex gap-2 justify-center">
          {onLeave && (
            <button
              type="button"
              onClick={onLeave}
              className="px-4 py-2 rounded-md text-sm font-semibold text-d-text2 hover:text-d-strong hover:bg-d-surface"
            >
              {t('chat.nsfwBack')}
            </button>
          )}
          <button
            type="button"
            onClick={enter}
            className="px-4 py-2 rounded-md bg-d-brand hover:bg-d-brandhover text-white text-sm font-semibold"
          >
            {t('chat.nsfwEnter')}
          </button>
        </div>
      </div>
    </div>
  );
}
