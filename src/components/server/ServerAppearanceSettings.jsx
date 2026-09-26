import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Upload, Trash2, Loader2, Plus, X, Sparkles, Compass } from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import { api as httpApi, upload as httpUpload } from '../../api';
import { proxiedImageUrl } from '../../utils/media';
import { Button, ToggleRow } from '../ui';
import ImageCropDialog from './ImageCropDialog.jsx';
import ServerProfileCard from './ServerProfileCard.jsx';
import AnimatedServerIcon from './AnimatedServerIcon.jsx';

const IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif';
const MAX_BYTES = 10 * 1024 * 1024;
const CATEGORIES = ['gaming', 'music', 'entertainment', 'education', 'science', 'art', 'community', 'other'];
const ACCENTS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22'];

function SectionTitle({ children, hint }) {
  return (
    <div className="mb-2">
      <h2 className="text-[11px] font-bold text-d-text2 uppercase">{children}</h2>
      {hint && <p className="text-xs text-d-text2 mt-0.5">{hint}</p>}
    </div>
  );
}

/** Banner or splash: preview, upload (with crop), remove. Saves immediately. */
function ImageSlot({ server, kind, title, hint, outputWidth, onServerUpdated, onToast }) {
  const inputRef = useRef(null);
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const url = kind === 'banner' ? server.banner_url : server.splash_url;
  const animated = kind === 'banner' ? Boolean(server.banner_animated) : /\.gif(\?|$)/i.test(url ?? '');

  const choose = (input) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!IMAGE_TYPES.split(',').includes(file.type)) { onToast?.(t('srv.imageType'), { type: 'error' }); return; }
    if (file.size > MAX_BYTES) { onToast?.(t('srv.imageTooLarge'), { type: 'error' }); return; }
    setPicked(file);
  };

  const send = async (file) => {
    setPicked(null);
    setBusy(true);
    try {
      const result = await httpUpload(`/api/servers/${server.id}/appearance/${kind}`, 'image', file);
      onServerUpdated?.(result.server);
      onToast?.(t('settings.saved'), { type: 'success', ttl: 2000 });
    } catch (err) {
      onToast?.(err.message ?? t('chat.uploadFailed'), { type: 'error' });
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const result = await httpApi(`/api/servers/${server.id}/appearance/${kind}`, { method: 'DELETE' });
      onServerUpdated?.(result.server);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally { setBusy(false); }
  };

  return (
    <div className="mb-6">
      <SectionTitle hint={hint}>{title}</SectionTitle>
      <div className="flex max-sm:flex-col gap-4 items-start">
        <div className="relative w-full max-w-[320px] aspect-video rounded-md overflow-hidden bg-d-base2 border border-d-divider shrink-0">
          {url ? (
            <AnimatedServerIcon src={proxiedImageUrl(url)} animated={animated} alt={title} className="w-full h-full object-cover" />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-xs text-d-text3 p-3 text-center">{t('srv.noImage')}</span>
          )}
          {kind === 'splash' && url && (
            <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
          )}
          {busy && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/50">
              <Loader2 className="w-5 h-5 animate-spin text-white" aria-label={t('common.uploading')} />
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            <Upload className="w-4 h-4" aria-hidden="true" /> {url ? t('srv.changeImage') : t('srv.uploadImage')}
          </Button>
          {url && (
            <Button size="sm" variant="danger-ghost" onClick={remove} disabled={busy}>
              <Trash2 className="w-4 h-4" aria-hidden="true" /> {t('common.remove')}
            </Button>
          )}
          <input ref={inputRef} type="file" accept={IMAGE_TYPES} className="hidden" aria-label={title} onChange={(e) => choose(e.target)} />
          <p className="w-full text-[11px] text-d-text2">{t('srv.imageSpec', { size: kind === 'banner' ? '960 × 540' : '1920 × 1080' })}</p>
        </div>
      </div>
      {picked && (
        <ImageCropDialog
          file={picked}
          aspect={16 / 9}
          outputWidth={outputWidth}
          title={t('srv.cropTitle', { what: title })}
          onCancel={() => setPicked(null)}
          onConfirm={send}
        />
      )}
    </div>
  );
}

/**
 * Overview › appearance: banner, invite splash, and the server profile card
 * (accent colour, traits, Discover listing). Everything here is free.
 */
export default function ServerAppearanceSettings({ server, onServerUpdated, onToast }) {
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const categoryId = useId();

  useEffect(() => {
    let alive = true;
    httpApi(`/api/servers/${server.id}/profile`)
      .then((p) => {
        if (!alive) return;
        setProfile(p);
        setForm({
          accent_color: p.accent_color ?? null,
          traits: p.traits ?? [],
          discoverable: Boolean(p.discoverable),
          discovery_category: p.discovery_category ?? ''
        });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [server.id]);

  const dirty = useMemo(() => profile && form && (
    (form.accent_color ?? null) !== (profile.accent_color ?? null)
    || JSON.stringify(form.traits) !== JSON.stringify(profile.traits ?? [])
    || form.discoverable !== Boolean(profile.discoverable)
    || (form.discovery_category || '') !== (profile.discovery_category || '')
  ), [form, profile]);

  const saveProfile = async () => {
    setSaving(true);
    try {
      const traits = form.traits
        .map((tr) => ({ emoji: tr.emoji?.trim() || null, label: tr.label.trim() }))
        .filter((tr) => tr.label);
      const next = await httpApi(`/api/servers/${server.id}/profile`, {
        method: 'PATCH',
        body: {
          accent_color: form.accent_color, traits,
          discovery_category: form.discovery_category || null,
          discoverable: form.discoverable
        }
      });
      setProfile(next);
      setForm({ ...form, traits: next.traits });
      onToast?.(t('settings.saved'), { type: 'success', ttl: 2000 });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally { setSaving(false); }
  };

  const setTrait = (i, patch) => setForm((f) => ({ ...f, traits: f.traits.map((tr, j) => (j === i ? { ...tr, ...patch } : tr)) }));
  const preview = profile && form ? {
    ...profile, ...server, id: server.id,
    accent_color: form.accent_color, traits: form.traits.filter((tr) => tr.label?.trim()),
    discovery_category: form.discovery_category || null, joined: false,
    online_count: profile.online_count, member_count: profile.member_count
  } : null;

  return (
    <div className="mb-8 border-t border-d-divider pt-6">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-4 h-4 text-d-text2" aria-hidden="true" />
        <p className="text-xs text-d-text2">{t('srv.allFree')}</p>
      </div>

      <ImageSlot
        server={server} kind="banner" outputWidth={1920}
        title={t('srv.bannerTitle')} hint={t('srv.bannerHint')}
        onServerUpdated={onServerUpdated} onToast={onToast}
      />
      <ImageSlot
        server={server} kind="splash" outputWidth={1920}
        title={t('srv.splashTitle')} hint={t('srv.splashHint')}
        onServerUpdated={onServerUpdated} onToast={onToast}
      />

      {form && (
        <div className="mb-6">
          <SectionTitle hint={t('srv.profileHint')}>{t('srv.profileTitle')}</SectionTitle>
          <div className="grid lg:grid-cols-[1fr_280px] gap-6 items-start">
            <div className="space-y-4 min-w-0">
              <fieldset>
                <legend className="text-xs font-semibold text-d-text mb-1.5">{t('srv.accentColour')}</legend>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, accent_color: null })}
                    aria-pressed={!form.accent_color}
                    aria-label={t('srv.accentDefault')}
                    title={t('srv.accentDefault')}
                    className={`w-7 h-7 rounded-full border-2 border-dashed border-d-text3 ${!form.accent_color ? 'ring-2 ring-d-strong ring-offset-1 ring-offset-d-canvas' : ''}`}
                  />
                  {ACCENTS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      data-custom-color
                      onClick={() => setForm({ ...form, accent_color: c })}
                      aria-pressed={form.accent_color === c}
                      aria-label={t('roles.colorSwatch', { color: c })}
                      style={{ backgroundColor: c }}
                      className={`w-7 h-7 rounded-full border border-black/20 ${form.accent_color === c ? 'ring-2 ring-d-strong ring-offset-1 ring-offset-d-canvas' : ''}`}
                    />
                  ))}
                  <input
                    type="color"
                    aria-label={t('srv.customColour')}
                    value={form.accent_color ?? '#5865f2'}
                    onChange={(e) => setForm({ ...form, accent_color: e.target.value })}
                    className="w-8 h-7 p-0 bg-transparent border border-d-divider rounded cursor-pointer"
                  />
                </div>
              </fieldset>

              <fieldset>
                <legend className="text-xs font-semibold text-d-text mb-1">{t('srv.traits')}</legend>
                <p className="text-[11px] text-d-text2 mb-2">{t('srv.traitsHint')}</p>
                <ul className="space-y-2">
                  {form.traits.map((trait, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <input
                        value={trait.emoji ?? ''}
                        onChange={(e) => setTrait(i, { emoji: e.target.value })}
                        aria-label={t('srv.traitEmoji', { n: i + 1 })}
                        placeholder="🎮"
                        maxLength={16}
                        className="w-12 min-h-9 text-center bg-d-base text-d-strong rounded border border-d-edge focus:outline-none focus:border-d-brand"
                      />
                      <input
                        value={trait.label}
                        onChange={(e) => setTrait(i, { label: e.target.value })}
                        aria-label={t('srv.traitLabel', { n: i + 1 })}
                        placeholder={t('srv.traitPlaceholder')}
                        maxLength={24}
                        className="flex-1 min-w-0 min-h-9 bg-d-base text-sm text-d-strong px-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
                      />
                      <button
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, traits: f.traits.filter((_, j) => j !== i) }))}
                        aria-label={t('srv.removeTrait', { n: i + 1 })}
                        className="w-9 h-9 shrink-0 rounded flex items-center justify-center text-d-text2 hover:bg-d-hover hover:text-d-danger"
                      >
                        <X className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
                {form.traits.length < 5 && (
                  <Button
                    size="sm" variant="ghost" className="mt-2"
                    onClick={() => setForm((f) => ({ ...f, traits: [...f.traits, { emoji: '', label: '' }] }))}
                  >
                    <Plus className="w-4 h-4" aria-hidden="true" /> {t('srv.addTrait')}
                  </Button>
                )}
              </fieldset>

              <div className="rounded-md border border-d-divider p-2">
                <ToggleRow
                  icon={Compass}
                  checked={form.discoverable}
                  onChange={(v) => setForm({ ...form, discoverable: v })}
                  label={t('srv.listInDiscover')}
                  hint={server.description ? t('srv.listInDiscoverHint') : t('srv.listNeedsDescription')}
                />
                {form.discoverable && (
                  <label htmlFor={categoryId} className="block px-2 pb-2">
                    <span className="block text-xs font-semibold text-d-text mb-1">{t('srv.discoveryCategory')}</span>
                    <select
                      id={categoryId}
                      value={form.discovery_category}
                      onChange={(e) => setForm({ ...form, discovery_category: e.target.value })}
                      className="w-full min-h-9 bg-d-base text-sm text-d-strong px-2 rounded border border-d-edge focus:outline-none"
                    >
                      <option value="">{t('common.none')}</option>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{t(`srv.category.${c}`)}</option>)}
                    </select>
                  </label>
                )}
              </div>

              <Button onClick={saveProfile} disabled={!dirty || saving}>
                {saving && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                {t('srv.saveProfile')}
              </Button>
            </div>

            <div>
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('srv.preview')}</span>
              <ServerProfileCard profile={preview} headingLevel={3} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
