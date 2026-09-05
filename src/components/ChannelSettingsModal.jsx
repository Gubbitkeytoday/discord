import React, { useState } from 'react';
import { Hash, Volume2, Trash2, X, Loader2, Megaphone, Check } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t } from '../i18n/index.jsx';

// Discord's slowmode presets, in seconds.
const SLOWMODE_STEPS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];

const slowmodeLabel = (seconds) => {
  if (!seconds) return t('channel.slowmodeOff');
  if (seconds < 60) return t('channel.seconds', { count: seconds });
  if (seconds < 3600) return t('channel.minutes', { count: Math.round(seconds / 60) });
  return t('channel.hours', { count: Math.round(seconds / 3600) });
};

/**
 * Channel settings: overview (name, topic, slowmode, NSFW, voice limits) and
 * the destructive actions. Permissions live in Server Settings, which is where
 * the full role list already is.
 */
export default function ChannelSettingsModal({ channel, canManage, onSave, onDelete, onClose, onToast }) {
  const [name, setName] = useState(channel.name ?? '');
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [slowmode, setSlowmode] = useState(Number(channel.rate_limit_per_user) || 0);
  const [nsfw, setNsfw] = useState(Boolean(channel.nsfw));
  const [userLimit, setUserLimit] = useState(Number(channel.user_limit) || 0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const dialogRef = useFocusTrap(true, onClose);

  const isVoice = channel.type === 'voice' || channel.type === 'stage';
  const Icon = isVoice ? Volume2 : channel.type === 'announcement' ? Megaphone : Hash;

  const dirty = name !== (channel.name ?? '')
    || topic !== (channel.topic ?? '')
    || slowmode !== (Number(channel.rate_limit_per_user) || 0)
    || nsfw !== Boolean(channel.nsfw)
    || userLimit !== (Number(channel.user_limit) || 0);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave({
        name,
        topic: topic || null,
        rate_limit_per_user: slowmode,
        nsfw,
        ...(isVoice ? { user_limit: userLimit } : {})
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center overlay-center p-4">
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('channel.settings')}
        onSubmit={save}
        className="bg-d-canvas w-full max-w-lg rounded-lg shadow-2xl border border-d-surface overflow-hidden"
      >
        <div className="p-5 border-b border-d-divider flex items-center justify-between">
          <h2 className="text-base font-bold text-d-strong flex items-center gap-2 min-w-0">
            <Icon className="w-5 h-5 text-d-text3 shrink-0" />
            <span className="truncate">{t('channel.settingsFor', { name: channel.name })}</span>
          </h2>
          <button type="button" onClick={onClose} className="text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[60vh] overflow-y-auto">
          <label className="block">
            <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('channel.name')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage}
              maxLength={100}
              className="w-full bg-d-base text-sm text-d-strong px-3 py-2.5 rounded border border-d-edge focus:outline-none focus:border-d-brand disabled:opacity-60"
            />
          </label>

          {!isVoice && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('channel.topic')}</span>
              <textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                disabled={!canManage}
                rows={3}
                maxLength={1024}
                placeholder={t('channel.topicPlaceholder')}
                className="w-full bg-d-base text-sm text-d-strong px-3 py-2.5 rounded border border-d-edge focus:outline-none focus:border-d-brand resize-none disabled:opacity-60"
              />
              <span className="block text-right text-[10px] text-d-text4 mt-1">{topic.length}/1024</span>
            </label>
          )}

          {!isVoice && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                {t('channel.slowmode')} — {slowmodeLabel(slowmode)}
              </span>
              <input
                type="range"
                min={0}
                max={SLOWMODE_STEPS.length - 1}
                step={1}
                value={Math.max(0, SLOWMODE_STEPS.indexOf(slowmode))}
                onChange={(e) => setSlowmode(SLOWMODE_STEPS[Number(e.target.value)])}
                disabled={!canManage}
                className="w-full accent-d-brand"
              />
              <span className="block text-[11px] text-d-text3 mt-1">{t('channel.slowmodeHint')}</span>
            </label>
          )}

          {isVoice && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                {t('channel.userLimit')} — {userLimit === 0 ? t('channel.noLimit') : userLimit}
              </span>
              <input
                type="range" min={0} max={20} step={1}
                value={userLimit}
                onChange={(e) => setUserLimit(Number(e.target.value))}
                disabled={!canManage}
                className="w-full accent-d-brand"
              />
            </label>
          )}

          {!isVoice && (
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm text-d-strong">{t('channel.nsfw')}</p>
                <p className="text-[11px] text-d-text3">{t('channel.nsfwHint')}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={nsfw}
                aria-label={t('channel.nsfw')}
                disabled={!canManage}
                onClick={() => setNsfw((v) => !v)}
                className={`w-10 h-5 rounded-full relative transition-colors shrink-0 ${nsfw ? 'bg-d-brand' : 'bg-d-text4'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${nsfw ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
          )}

          {canManage && (
            <div className="pt-2 border-t border-d-divider">
              <button
                type="button"
                onClick={onDelete}
                className="flex items-center gap-2 text-sm text-d-danger hover:underline"
              >
                <Trash2 className="w-4 h-4" /> {t('channel.deleteChannel')}
              </button>
            </div>
          )}
        </div>

        <div className="bg-d-surface px-5 py-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-semibold text-d-strong hover:underline">
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!canManage || !dirty || busy || !name.trim()}
            className="px-5 py-2 rounded text-sm font-semibold text-white bg-d-brand hover:bg-d-brandhover disabled:opacity-50 flex items-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : null}
            {saved ? t('common.saved') : t('common.saveChanges')}
          </button>
        </div>
      </form>
    </div>
  );
}
