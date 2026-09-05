// ============================================================================
//  Profile.
//
//  Discord puts the live profile card beside the fields rather than above them,
//  so you watch the thing you are editing change as you type. The save bar is a
//  floating pill anchored to the bottom of the content column — it follows you
//  down the page instead of sitting off-screen at the end of the form.
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Check, Camera } from 'lucide-react';
import { upload } from '../../api';
import { t } from '../../i18n/index.jsx';
import { DEFAULT_AVATAR } from '../../utils/avatar';
import { PageHeader, Section, Field, Divider, inputClass, Button, Select } from './primitives';

const BLANK = {
  display_name: '', pronouns: '', bio: '',
  avatar_url: '', banner_url: '', accent_color: '#5865f2'
};

const readProfile = (user) => ({
  display_name: user?.display_name || '',
  pronouns: user?.pronouns || '',
  bio: user?.bio || '',
  avatar_url: user?.avatar_url || '',
  banner_url: user?.banner_url || '',
  accent_color: user?.accent_color || '#5865f2'
});

/** What the server will accept, so we can say no before spending the upload. */
const MAX_BYTES = { avatar: 10 * 1024 * 1024, banner: 15 * 1024 * 1024 };
const ACCEPTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];

export default function ProfileTab({ currentUser, onSaveProfile, onSetStatus, onToast }) {
  const [form, setForm] = useState(() => readProfile(currentUser) ?? BLANK);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(null);
  // Discord shows the picked image the instant you choose it, while the upload
  // is still in flight. Without that the UI looks frozen on a slow connection
  // and people click again thinking nothing happened.
  const [preview, setPreview] = useState({ avatar: null, banner: null });
  const avatarInput = useRef(null);
  const bannerInput = useRef(null);

  // Object URLs are a manual allocation; drop them when the tab goes away.
  useEffect(() => () => {
    Object.values(preview).forEach((url) => url && URL.revokeObjectURL(url));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const original = readProfile(currentUser);
  const dirty = Object.keys(original).some((key) => form[key] !== original[key]);
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  // Follow an external change (another device, a socket update) — but never
  // while there are local edits waiting to be saved.
  useEffect(() => {
    if (dirty) return;
    setForm(readProfile(currentUser));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, currentUser?.display_name, currentUser?.pronouns, currentUser?.bio,
      currentUser?.avatar_url, currentUser?.banner_url, currentUser?.accent_color]);

  useEffect(() => {
    const beforeUnload = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const pickImage = async (kind, file, inputRef) => {
    // Reset the input first: without this, choosing the *same* file twice fires
    // no change event, so a retry after an error looks like a dead button.
    if (inputRef?.current) inputRef.current.value = '';
    if (!file) return;

    if (!ACCEPTED.includes(file.type)) {
      onToast?.(t('settings.uploadWrongType'), { type: 'error' });
      return;
    }
    if (file.size > MAX_BYTES[kind]) {
      onToast?.(
        t('settings.uploadTooLarge', { limit: Math.round(MAX_BYTES[kind] / 1024 / 1024) }),
        { type: 'error' }
      );
      return;
    }

    const localUrl = URL.createObjectURL(file);
    setPreview((current) => {
      if (current[kind]) URL.revokeObjectURL(current[kind]);
      return { ...current, [kind]: localUrl };
    });
    setUploading(kind);

    try {
      const path = kind === 'avatar' ? '/api/upload/avatar' : '/api/upload/banner';
      const data = await upload(path, kind, file);
      if (!data?.url) throw new Error(t('settings.uploadFailed'));
      set({ [kind === 'avatar' ? 'avatar_url' : 'banner_url']: data.url });
    } catch (err) {
      // The upload failed, so the optimistic preview is a lie — take it back.
      setPreview((current) => {
        if (current[kind]) URL.revokeObjectURL(current[kind]);
        return { ...current, [kind]: null };
      });
      onToast?.(err.message, { type: 'error' });
    } finally {
      setUploading(null);
    }
  };

  const clearImage = (kind) => {
    setPreview((current) => {
      if (current[kind]) URL.revokeObjectURL(current[kind]);
      return { ...current, [kind]: null };
    });
    set({ [kind === 'avatar' ? 'avatar_url' : 'banner_url']: '' });
  };

  // What to show: the local file while it uploads, otherwise the saved URL.
  const avatarSrc = preview.avatar ?? (form.avatar_url || DEFAULT_AVATAR);
  const bannerSrc = preview.banner ?? form.banner_url;

  const save = async () => {
    setBusy(true);
    try {
      await onSaveProfile({
        display_name: form.display_name.trim() || currentUser?.username,
        pronouns: form.pronouns.trim() || null,
        bio: form.bio.trim() || null,
        avatar_url: form.avatar_url || null,
        banner_url: form.banner_url || null,
        accent_color: form.accent_color
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
    <div className="relative pb-24">
      <PageHeader title={t('settings.profileTitle')} description={t('settings.profileLead')} />

      <div className="grid gap-8 lg:grid-cols-[1fr_260px]">
        {/* --- fields ------------------------------------------------------- */}
        <div className="min-w-0 space-y-4">
          <Field label={t('settings.displayName')} htmlFor="profile-display-name">
            <input
              id="profile-display-name"
              value={form.display_name}
              onChange={(event) => set({ display_name: event.target.value })}
              maxLength={80}
              className={inputClass}
            />
          </Field>

          <Field label={t('settings.pronouns')} htmlFor="profile-pronouns">
            <input
              id="profile-pronouns"
              value={form.pronouns}
              onChange={(event) => set({ pronouns: event.target.value })}
              maxLength={40}
              placeholder={t('settings.pronounsPlaceholder')}
              className={inputClass}
            />
          </Field>

          <Field label={t('settings.aboutMe')} htmlFor="profile-bio">
            <textarea
              id="profile-bio"
              value={form.bio}
              onChange={(event) => set({ bio: event.target.value })}
              rows={4}
              maxLength={190}
              className={`${inputClass} resize-none`}
            />
            <span className="mt-1 block text-right text-[11px] text-d-text4 tabular-nums">
              {form.bio.length}/190
            </span>
          </Field>

          <Divider />

          <Section title={t('settings.avatar')}>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => avatarInput.current?.click()}
                aria-label={t('settings.changeAvatar')}
                className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-full
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand"
              >
                <img src={avatarSrc} alt="" className="h-full w-full object-cover" />
                {/* One overlay: a spinner that stays put while uploading, or a
                    camera that appears on hover. Two of them stacked. */}
                <span
                  className={`absolute inset-0 flex items-center justify-center bg-black/55
                    transition-opacity ${uploading === 'avatar'
                      ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                >
                  {uploading === 'avatar'
                    ? <Loader2 className="h-5 w-5 animate-spin text-white" />
                    : <Camera className="h-5 w-5 text-white" />}
                </span>
              </button>

              <div className="flex flex-col items-start gap-2">
                <Button size="sm" variant="primary" onClick={() => avatarInput.current?.click()}
                  disabled={uploading === 'avatar'}>
                  {t('settings.changeAvatar')}
                </Button>
                {(form.avatar_url || preview.avatar) && (
                  <button
                    type="button"
                    onClick={() => clearImage('avatar')}
                    className="text-sm text-d-text2 transition-colors hover:text-d-danger hover:underline"
                  >
                    {t('settings.removeAvatar')}
                  </button>
                )}
              </div>
            </div>
            <input
              ref={avatarInput}
              type="file"
              accept={ACCEPTED.join(',')}
              className="hidden"
              aria-label={t('settings.avatar')}
              onChange={(event) => pickImage('avatar', event.target.files?.[0], avatarInput)}
            />
          </Section>

          <Divider />

          <Section title={t('settings.banner')}>
            <button
              type="button"
              onClick={() => bannerInput.current?.click()}
              aria-label={t('settings.changeBanner')}
              className="group relative block h-24 w-full overflow-hidden rounded-lg border
                border-d-divider focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand"
              style={{ backgroundColor: form.accent_color }}
            >
              {bannerSrc && <img src={bannerSrc} alt="" className="h-full w-full object-cover" />}
              <span
                className={`absolute inset-0 flex items-center justify-center bg-black/45 text-sm
                  font-medium text-white transition-opacity ${uploading === 'banner'
                    ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
              >
                {uploading === 'banner'
                  ? <Loader2 className="h-5 w-5 animate-spin" />
                  : <><Camera className="mr-2 h-4 w-4" /> {t('settings.changeBanner')}</>}
              </span>
            </button>
            {(form.banner_url || preview.banner) && (
              <button
                type="button"
                onClick={() => clearImage('banner')}
                className="mt-2 text-sm text-d-text2 transition-colors hover:text-d-danger hover:underline"
              >
                {t('settings.removeBanner')}
              </button>
            )}
            <input
              ref={bannerInput}
              type="file"
              accept={ACCEPTED.join(',')}
              className="hidden"
              aria-label={t('settings.banner')}
              onChange={(event) => pickImage('banner', event.target.files?.[0], bannerInput)}
            />
          </Section>

          <Divider />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('status.label')} htmlFor="profile-status">
              <Select
                id="profile-status"
                value={currentUser?.status ?? 'online'}
                onChange={(value) => onSetStatus?.(value)}
                label={t('status.label')}
              >
                <option value="online">{t('status.online')}</option>
                <option value="idle">{t('status.idle')}</option>
                <option value="dnd">{t('status.dnd')}</option>
                <option value="invisible">{t('status.invisible')}</option>
              </Select>
            </Field>

            <Field label={t('settings.accentColor')} htmlFor="profile-accent">
              <div className="flex items-center gap-3">
                <input
                  id="profile-accent"
                  type="color"
                  value={form.accent_color}
                  onChange={(event) => set({ accent_color: event.target.value })}
                  className="h-10 w-16 cursor-pointer rounded border border-d-divider bg-transparent"
                />
                <code className="text-xs text-d-text3 uppercase">{form.accent_color}</code>
              </div>
            </Field>
          </div>
        </div>

        {/* --- live preview -------------------------------------------------- */}
        <div className="lg:sticky lg:top-15 lg:self-start">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-[0.02em] text-d-text2">
            {t('settings.preview')}
          </h3>
          <div className="overflow-hidden rounded-xl border border-d-divider bg-d-base shadow-lg">
            <div
              className="h-[60px] bg-cover bg-center"
              style={{
                backgroundImage: bannerSrc ? `url(${bannerSrc})` : undefined,
                backgroundColor: form.accent_color
              }}
            />
            <div className="relative px-4 pb-4">
              <img
                src={avatarSrc}
                alt=""
                className="relative -top-8 mb-[-1.75rem] h-[72px] w-[72px] rounded-full border-[6px]
                  border-d-base object-cover"
              />
              <h4 className="text-base font-bold leading-tight text-d-strong">
                {form.display_name || currentUser?.username}
              </h4>
              <p className="text-xs text-d-text3">
                @{currentUser?.username}
                {currentUser?.discriminator ? `#${currentUser.discriminator}` : ''}
                {form.pronouns ? ` · ${form.pronouns}` : ''}
              </p>
              {form.bio && (
                <p className="mt-3 whitespace-pre-wrap border-t border-d-divider pt-3 text-xs
                  leading-relaxed text-d-text">
                  {form.bio}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* --- unsaved changes bar --------------------------------------------- */}
      {dirty && (
        <div
          role="status"
          className="sticky bottom-4 z-10 mt-8 flex items-center justify-between gap-4 rounded-lg
            bg-d-base3 px-4 py-3 shadow-xl ring-1 ring-black/20
            animate-[settingsBarIn_180ms_cubic-bezier(0.2,0.9,0.3,1.3)]"
        >
          <span className="text-sm font-medium text-d-strong">{t('common.unsavedChanges')}</span>
          <div className="flex shrink-0 items-center gap-3">
            <button
              onClick={() => setForm(readProfile(currentUser))}
              className="text-sm font-medium text-d-strong hover:underline"
            >
              {t('common.reset')}
            </button>
            <Button variant="primary" onClick={save} disabled={busy} className="bg-d-success hover:bg-d-successhover">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
              {saved ? t('common.saved') : t('common.saveChanges')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
