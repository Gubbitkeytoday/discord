import React, { useState } from 'react';
import { X, Hash, Volume2, Megaphone, Lock, MessagesSquare, Image as ImageIcon, Radio } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t } from '../i18n/index.jsx';

const channelTypes = () => [
  { value: 'text',         icon: Hash,      title: t('channel.typeText'),         description: t('channel.typeTextHint') },
  { value: 'voice',        icon: Volume2,   title: t('channel.typeVoice'),        description: t('channel.typeVoiceHint') },
  { value: 'announcement', icon: Megaphone, title: t('channel.typeAnnouncement'), description: t('channel.typeAnnouncementHint') },
  { value: 'forum',        icon: MessagesSquare, title: t('channel.typeForum'),   description: t('channel.typeForumHint') },
  { value: 'media',        icon: ImageIcon, title: t('channel.typeMedia'),        description: t('channel.typeMediaHint') },
  { value: 'stage',        icon: Radio,     title: t('channel.typeStage'),        description: t('channel.typeStageHint') }
];

export default function CreateChannelModal({ defaultType = 'text', categories = [], onClose, onCreateChannel }) {
  const [channelName, setChannelName] = useState('');
  const [type, setType] = useState(defaultType);
  const [isPrivate, setIsPrivate] = useState(false);
  const [category, setCategory] = useState(categories[0] ?? '');
  const [busy, setBusy] = useState(false);
  const dialogRef = useFocusTrap(true, onClose);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!channelName.trim()) return;
    setBusy(true);
    await onCreateChannel({
      name: channelName.trim(),
      type,
      isPrivate,
      category: category || (type === 'voice' ? 'VOICE CHANNELS' : 'TEXT CHANNELS')
    });
    onClose();
  };

  // Discord slugifies text-ish names live in the field.
  const preview = ['text', 'announcement', 'forum', 'media'].includes(type)
    ? channelName.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '')
    : channelName;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center overlay-center p-4">
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('server.createChannel')}
        onSubmit={handleSubmit}
        className="bg-d-canvas w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border border-d-surface"
      >
        <div className="p-6 pb-2 flex items-center justify-between">
          <h2 className="text-xl font-bold text-d-strong">{t('server.createChannel')}</h2>
          <button type="button" onClick={onClose} className="text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 pt-2 space-y-4 max-h-[65vh] overflow-y-auto">
          <fieldset>
            <legend className="block text-xs font-bold text-d-text2 uppercase tracking-wider mb-2">
              {t('channel.type')}
            </legend>
            <div className="space-y-2">
              {channelTypes().map((option) => (
                <label
                  key={option.value}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    type === option.value ? 'bg-d-active border-d-brand' : 'bg-d-surface border-d-divider hover:bg-d-hover/40'
                  }`}
                >
                  <input
                    type="radio"
                    name="channel-type"
                    value={option.value}
                    checked={type === option.value}
                    onChange={() => setType(option.value)}
                    className="sr-only"
                  />
                  <option.icon className="w-6 h-6 text-d-text3 shrink-0" />
                  <span className="min-w-0">
                    <span className="block font-bold text-d-strong text-sm">{option.title}</span>
                    <span className="block text-xs text-d-text3">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="block text-xs font-bold text-d-text2 uppercase tracking-wider mb-2">
              {t('channel.name')}
            </span>
            <div className="relative">
              <span className="absolute left-3 top-3 text-d-text3 font-semibold" aria-hidden="true">
                {type === 'voice' ? '🔊' : '#'}
              </span>
              <input
                type="text"
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                placeholder={t('channel.namePlaceholder')}
                required
                maxLength={100}
                autoFocus
                className="w-full bg-d-base text-d-strong pl-8 pr-4 py-2.5 rounded-lg border border-d-divider focus:outline-none focus:border-d-brand text-sm"
              />
            </div>
            {preview && preview !== channelName && (
              <span className="block text-[11px] text-d-text4 mt-1">{t('channel.willBeNamed', { name: preview })}</span>
            )}
          </label>

          {categories.length > 0 && (
            <label className="block">
              <span className="block text-xs font-bold text-d-text2 uppercase tracking-wider mb-2">
                {t('channel.category')}
              </span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full bg-d-base text-d-strong px-3 py-2.5 rounded-lg border border-d-divider focus:outline-none focus:border-d-brand text-sm"
              >
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}

          <div className="flex items-center justify-between gap-4 pt-2 border-t border-d-divider">
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm text-d-strong">
                <Lock className="w-3.5 h-3.5" /> {t('channel.private')}
              </span>
              <span className="block text-[11px] text-d-text3">{t('channel.privateHint')}</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={isPrivate}
              aria-label={t('channel.private')}
              onClick={() => setIsPrivate((v) => !v)}
              className={`w-10 h-5 rounded-full relative transition-colors shrink-0 ${isPrivate ? 'bg-d-brand' : 'bg-d-text4'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${isPrivate ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>
        </div>

        <div className="bg-d-surface px-6 py-4 flex justify-between items-center">
          <button type="button" onClick={onClose} className="text-sm font-semibold text-d-strong hover:underline">
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!channelName.trim() || busy}
            className="bg-d-brand hover:bg-d-brandhover text-white px-6 py-2.5 rounded-md text-sm font-semibold transition-colors disabled:opacity-50"
          >
            {t('server.createChannel')}
          </button>
        </div>
      </form>
    </div>
  );
}
