import React, { useEffect, useRef, useState } from 'react';
import { X, Camera, Loader2, ArrowLeft, LayoutTemplate, Hash, Volume2, MessagesSquare } from 'lucide-react';
import { upload, get } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t } from '../i18n/index.jsx';

/**
 * Discord's create/join fork: choose to make a server or paste an invite.
 */
export default function CreateServerModal({ onClose, onCreateServer, onJoinWithInvite, onCreateFromTemplate, initialTemplateCode = null }) {
  const [mode, setMode] = useState(initialTemplateCode ? 'template' : 'choose');   // choose | create | join | template
  const [templateInput, setTemplateInput] = useState(initialTemplateCode ?? '');
  const [template, setTemplate] = useState(null);   // preview from /api/templates/:code
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const [serverName, setServerName] = useState('');
  const [iconUrl, setIconUrl] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);
  const dialogRef = useFocusTrap(true, onClose);

  const pickIcon = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const data = await upload('/api/upload/server-icon', 'icon', file);
      if (data.url) setIconUrl(data.url);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submitCreate = (e) => {
    e.preventDefault();
    if (!serverName.trim()) return;
    onCreateServer(serverName.trim(), iconUrl);
    onClose();
  };

  const lookupTemplate = async (e) => {
    e.preventDefault();
    const code = templateInput.trim().split('/').filter(Boolean).pop();
    if (!code) { setError(t('server.invalidTemplate')); return; }
    setLoadingTemplate(true); setError(null);
    try {
      const preview = await get(`/api/templates/${encodeURIComponent(code)}`);
      setTemplate(preview);
      if (!serverName.trim()) setServerName(preview.name);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingTemplate(false);
    }
  };

  // Deep link: /template/:code — look the code up straight away.
  useEffect(() => {
    if (initialTemplateCode) lookupTemplate({ preventDefault() {} });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitTemplate = (e) => {
    e.preventDefault();
    if (!template || !serverName.trim()) return;
    onCreateFromTemplate?.(template.code, serverName.trim(), iconUrl);
  };

  const submitJoin = (e) => {
    e.preventDefault();
    const code = inviteInput.trim().split('/').filter(Boolean).pop();
    if (!code) { setError(t('server.invalidInvite')); return; }
    onJoinWithInvite(code);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center overlay-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('server.addServer')}
        className="bg-d-canvas w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border border-d-surface"
      >
        <div className="p-6 text-center relative">
          {mode !== 'choose' && (
            <button
              onClick={() => { setMode('choose'); setError(null); }}
              className="absolute top-4 left-4 text-d-text3 hover:text-d-strong"
              aria-label={t('common.back')}
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <button onClick={onClose} className="absolute top-4 right-4 text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
          <h2 className="text-2xl font-extrabold text-d-strong mb-2">
            {mode === 'join' ? t('server.joinTitle') : mode === 'template' ? t('server.templateTitle') : t('server.createTitle')}
          </h2>
          <p className="text-sm text-d-text3">
            {mode === 'join' ? t('server.joinHint') : mode === 'template' ? t('server.templateHint') : t('server.createHint')}
          </p>
        </div>

        {error && <p className="px-6 pb-2 text-xs text-d-danger text-center">{error}</p>}

        {mode === 'choose' && (
          <div className="px-6 pb-6 space-y-3">
            <button
              onClick={() => setMode('create')}
              className="w-full bg-d-brand hover:bg-d-brandhover text-white font-semibold py-3 rounded-lg transition-colors"
            >
              {t('server.createOwn')}
            </button>
            {onCreateFromTemplate && (
              <button
                onClick={() => setMode('template')}
                className="w-full bg-d-surface hover:bg-d-hover text-d-strong font-semibold py-3 rounded-lg border border-d-divider transition-colors inline-flex items-center justify-center gap-2"
              >
                <LayoutTemplate className="w-4 h-4" aria-hidden="true" />{t('server.useTemplate')}
              </button>
            )}
            <div className="text-center text-xs text-d-text3">{t('server.haveInvite')}</div>
            <button
              onClick={() => setMode('join')}
              className="w-full bg-d-surface hover:bg-d-hover text-d-strong font-semibold py-3 rounded-lg border border-d-divider transition-colors"
            >
              {t('server.join')}
            </button>
          </div>
        )}

        {mode === 'template' && (
          <div className="px-6 pb-6 space-y-4">
            <form onSubmit={lookupTemplate} className="flex gap-2">
              <input
                type="text"
                value={templateInput}
                onChange={(e) => setTemplateInput(e.target.value)}
                placeholder={t('server.templateCodePlaceholder')}
                aria-label={t('server.templateCode')}
                autoFocus
                className="flex-1 bg-d-base text-d-strong px-4 py-3 rounded-lg border border-d-divider focus:outline-none focus:border-d-brand text-sm"
              />
              <button type="submit" disabled={loadingTemplate || !templateInput.trim()}
                className="bg-d-surface hover:bg-d-hover disabled:opacity-50 text-d-strong font-semibold px-4 rounded-lg border border-d-divider">
                {loadingTemplate ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : t('server.templateLookup')}
              </button>
            </form>

            {template && (
              <form onSubmit={submitTemplate} className="space-y-4">
                <div className="bg-d-surface/60 border border-d-edge rounded-lg p-3">
                  <div className="font-semibold text-d-strong text-sm">{template.name}</div>
                  {template.description && <div className="text-xs text-d-text3 mt-0.5">{template.description}</div>}
                  <div className="text-[11px] text-d-text3 mt-1">
                    {t('server.templateStats', { channels: template.channel_count, roles: template.role_count, uses: template.usage_count })}
                  </div>
                  <ul className="mt-2 max-h-40 overflow-y-auto space-y-0.5 text-xs">
                    {template.preview.channels.filter((c) => c.type === 'category').map((cat) => (
                      <li key={cat.key}>
                        <div className="uppercase tracking-wide text-[10px] text-d-text3 mt-1">{cat.name}</div>
                        {template.preview.channels.filter((c) => c.parent === cat.key).map((c) => (
                          <div key={c.key} className="flex items-center gap-1.5 text-d-text2 pl-2">
                            {c.type === 'voice' || c.type === 'stage' ? <Volume2 className="w-3 h-3" aria-hidden="true" /> : c.type === 'forum' ? <MessagesSquare className="w-3 h-3" aria-hidden="true" /> : <Hash className="w-3 h-3" aria-hidden="true" />}
                            {c.name}
                          </div>
                        ))}
                      </li>
                    ))}
                  </ul>
                </div>
                <label className="block">
                  <span className="block text-xs font-bold text-d-text2 uppercase tracking-wider mb-2">{t('server.name')}</span>
                  <input
                    type="text"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    required
                    maxLength={100}
                    className="w-full bg-d-base text-d-strong px-4 py-3 rounded-lg border border-d-divider focus:outline-none focus:border-d-brand text-sm"
                  />
                </label>
                <button type="submit" disabled={!serverName.trim()}
                  className="w-full bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg transition-colors">
                  {t('server.createFromTemplate')}
                </button>
              </form>
            )}
          </div>
        )}

        {mode === 'create' && (
          <form onSubmit={submitCreate} className="px-6 pb-6 space-y-4">
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="relative w-20 h-20 rounded-full border-2 border-dashed border-d-text4 hover:border-d-brand flex items-center justify-center overflow-hidden transition-colors"
                aria-label={t('server.iconAlt')}
              >
                {iconUrl
                  ? <img src={iconUrl} alt="" className="w-full h-full object-cover" />
                  : uploading
                  ? <Loader2 className="w-6 h-6 animate-spin text-d-text3" />
                  : <Camera className="w-6 h-6 text-d-text3" />}
              </button>
              <input ref={fileRef} type="file" accept="image/*" onChange={pickIcon} className="hidden" aria-label={t('server.iconAlt')} />
            </div>

            <label className="block">
              <span className="block text-xs font-bold text-d-text2 uppercase tracking-wider mb-2">
                {t('server.name')}
              </span>
              <input
                type="text"
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
                placeholder={t('server.namePlaceholder')}
                required
                maxLength={100}
                autoFocus
                className="w-full bg-d-base text-d-strong px-4 py-3 rounded-lg border border-d-divider focus:outline-none focus:border-d-brand text-sm"
              />
            </label>

            <button
              type="submit"
              disabled={!serverName.trim() || uploading}
              className="w-full bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg transition-colors"
            >
              {t('common.create')}
            </button>
          </form>
        )}

        {mode === 'join' && (
          <form onSubmit={submitJoin} className="px-6 pb-6 space-y-4">
            <label className="block">
              <span className="block text-xs font-bold text-d-text2 uppercase tracking-wider mb-2">
                {t('server.inviteLink')}
              </span>
              <input
                value={inviteInput}
                onChange={(e) => { setInviteInput(e.target.value); setError(null); }}
                placeholder={`${window.location.origin}/invite/abc123`}
                autoFocus
                className="w-full bg-d-base text-d-strong px-4 py-3 rounded-lg border border-d-divider focus:outline-none focus:border-d-brand text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={!inviteInput.trim()}
              className="w-full bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg transition-colors"
            >
              {t('server.join')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
