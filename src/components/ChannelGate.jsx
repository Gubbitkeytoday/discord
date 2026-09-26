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

import React, { useEffect, useState } from 'react';
import { AlertTriangle, EyeOff, ShieldBan, Loader2 } from 'lucide-react';
import { get, put, getApiUserId } from '../api';
import { t } from '../i18n/index.jsx';
import BirthdateFields, { ageFromFields } from './admin/BirthdateFields';
import { updateAccountFlags } from './admin/safety';

// The signed-in account's age group, fetched once per account per page load:
// 'minor' | 'adult' | 'unknown'. Only the group reaches the client, never the
// birth date. Keyed by account so a shared tab never reuses another's answer.
const ageGroupCache = new Map();
function loadAgeGroup() {
  const key = getApiUserId() ?? 'anonymous';
  if (!ageGroupCache.has(key)) {
    ageGroupCache.set(key, get('/api/auth/age')
      .then((r) => r?.age_group ?? 'unknown')
      .catch(() => { ageGroupCache.delete(key); return 'unknown'; }));
  }
  return ageGroupCache.get(key);
}

/**
 * Age-restricted channels are for adults. A teen account is refused outright
 * (no "Continue" to click through); an account with no birth date is asked
 * for one first, as Discord does.
 */
function useAgeGroup(needed) {
  const [group, setGroup] = useState(null);
  useEffect(() => {
    if (!needed) return undefined;
    let live = true;
    loadAgeGroup().then((g) => { if (live) setGroup(g); });
    return () => { live = false; };
  }, [needed]);
  const update = (g) => { ageGroupCache.set(getApiUserId() ?? 'anonymous', Promise.resolve(g)); setGroup(g); };
  return [group, update];
}

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

  const [ageGroup, setAgeGroup] = useAgeGroup(kind === 'nsfw');

  if (kind === 'nsfw' && ageGroup === null) {
    return (
      <div className="flex-1 flex items-center justify-center bg-d-canvas text-d-text3" role="status">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
        <span className="sr-only">{t('common.loading')}</span>
      </div>
    );
  }
  if (kind === 'nsfw' && ageGroup === 'minor') return <AgeRefused onLeave={onLeave} />;
  if (kind === 'nsfw' && ageGroup === 'unknown') {
    return <AgeCheck onLeave={onLeave} onAnswered={setAgeGroup} />;
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

function GateShell({ icon: Icon, title, children }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8 bg-d-canvas overflow-y-auto">
      <div className="max-w-sm w-full text-center" role="alertdialog" aria-labelledby="gate-title">
        <Icon className="w-12 h-12 mx-auto text-d-text4" aria-hidden="true" />
        <h2 id="gate-title" className="mt-4 text-lg font-bold text-d-strong">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function AgeRefused({ onLeave }) {
  return (
    <GateShell icon={ShieldBan} title={t('safety.ageRestrictedTitle')}>
      <p className="mt-2 text-sm text-d-text3 leading-relaxed">{t('safety.ageRestrictedTeen')}</p>
      {onLeave && (
        <button
          type="button"
          onClick={onLeave}
          className="mt-6 min-h-10 px-4 rounded-md bg-d-brand hover:bg-d-brandhover text-white text-sm font-semibold"
        >
          {t('chat.nsfwBack')}
        </button>
      )}
    </GateShell>
  );
}

function AgeCheck({ onLeave, onAnswered }) {
  const [value, setValue] = useState({ day: '', month: '', year: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (event) => {
    event.preventDefault();
    if (ageFromFields(value) == null) { setError(t('safety.dobIncomplete')); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await put('/api/auth/age', { year: Number(value.year), month: Number(value.month), day: Number(value.day) });
      const userId = getApiUserId();
      if (userId) updateAccountFlags(userId, { birthdate_set: true, age_group: result?.age_group ?? 'unknown' });
      onAnswered(result?.age_group ?? 'unknown');
    } catch (err) {
      setError(err.code === 'AGE_TOO_YOUNG' ? t('safety.tooYoung') : err.message);
      setBusy(false);
    }
  };
  return (
    <GateShell icon={AlertTriangle} title={t('safety.ageCheckTitle')}>
      <p className="mt-2 mb-4 text-sm text-d-text3 leading-relaxed">{t('safety.ageCheckBody')}</p>
      <form onSubmit={submit} className="text-left">
        <BirthdateFields value={value} onChange={(v) => { setValue(v); setError(null); }} required />
        {error && <p role="alert" className="mt-2 text-sm text-d-danger">{error}</p>}
        <div className="mt-5 flex gap-2 justify-center">
          {onLeave && (
            <button type="button" onClick={onLeave} className="min-h-10 px-4 rounded-md text-sm font-semibold text-d-text2 hover:text-d-strong hover:bg-d-surface">
              {t('chat.nsfwBack')}
            </button>
          )}
          <button type="submit" disabled={busy} className="flex min-h-10 items-center gap-2 px-4 rounded-md bg-d-brand hover:bg-d-brandhover text-white text-sm font-semibold disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t('safety.confirmAge')}
          </button>
        </div>
      </form>
    </GateShell>
  );
}
