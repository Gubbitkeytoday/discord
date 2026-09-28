// ============================================================================
//  Profile.
//
//  Discord puts the live profile card beside the fields rather than above them,
//  so you watch the thing you are editing change as you type. The preview is
//  the real ProfileCard (the same component the popout and full profile use),
//  so what you see is what others see. Everything here is free.
//
//  Two saves happen behind one "Save changes": the account fields (PUT
//  /api/users/:id via onSaveProfile) and the identity (PATCH
//  /api/profiles/@me/identity: theme, name style, worn tag, collectibles).
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Check, Camera, Bold, Italic, Strikethrough, EyeOff, Link2 } from 'lucide-react';
import { upload } from '../../api';
import { t } from '../../i18n/index.jsx';
import { DEFAULT_AVATAR } from '../../utils/avatar';
import { proxiedImageUrl } from '../../utils/media';
import {
  PageHeader, Section, Field, Divider, inputClass, Button, Select, UnsavedBar, useReportDirty, SettingToggle, Segmented
} from './primitives';
import ProfilePreview from '../profile/ProfilePreview';
import CropDialog from '../profile/CropDialog';
import CosmeticPicker from '../profile/CosmeticPicker';
import { NameStyleEditor, ThemeColorsEditor } from '../profile/IdentityEditors';
import { ServerTagChip } from '../profile/DisplayName';
import { useCatalogueByKind, useIdentity, announceLocalIdentityChange } from '../../profile/store';
import { fetchMyIdentity, updateMyIdentity } from '../../profile/api';
import { useViewerPrefs, setViewerPrefs } from '../../profile/motion';
import { BIO_MAX } from '../../profile/text.jsx';

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

const IDENTITY_KEYS = [
  'theme_colors', 'name_style', 'primary_server_tag_id',
  'avatar_decoration_id', 'profile_effect_id', 'nameplate_id', 'profile_frame_id'
];
const readIdentity = (s) => Object.fromEntries(IDENTITY_KEYS.map((k) => [k, s?.[k] ?? null]));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const KIND_FIELD = {
  avatar_decoration: 'avatar_decoration_id',
  profile_effect: 'profile_effect_id',
  nameplate: 'nameplate_id',
  profile_frame: 'profile_frame_id'
};

/** What the server will accept, so we can say no before spending the upload. */
const MAX_BYTES = { avatar: 10 * 1024 * 1024, banner: 15 * 1024 * 1024 };
const ACCEPTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];

export default function ProfileTab({ currentUser, onSaveProfile, onSetStatus, onToast, onDirtyChange, nudge = 0 }) {
  const [form, setForm] = useState(() => readProfile(currentUser) ?? BLANK);
  const [identitySaved, setIdentitySaved] = useState(null);   // server state
  const [ident, setIdent] = useState(readIdentity(null));     // draft
  const [wearable, setWearable] = useState([]);
  const [statusExtra, setStatusExtra] = useState({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [cropping, setCropping] = useState(null);             // { kind, file, inputRef }
  const [kindTab, setKindTab] = useState('avatar_decoration');
  // Discord shows the picked image the instant you choose it, while the upload
  // is still in flight. Without that the UI looks frozen on a slow connection
  // and people click again thinking nothing happened.
  const [preview, setPreview] = useState({ avatar: null, banner: null });
  const avatarInput = useRef(null);
  const bannerInput = useRef(null);
  const bioRef = useRef(null);
  const catalogue = useCatalogueByKind();
  const liveIdentity = useIdentity(currentUser?.id);
  const viewer = useViewerPrefs();

  useEffect(() => {
    let cancelled = false;
    fetchMyIdentity()
      .then((s) => {
        if (cancelled) return;
        setIdentitySaved(readIdentity(s));
        setIdent(readIdentity(s));
        setWearable(s.wearable_tags ?? []);
        setStatusExtra({ custom_status: s.custom_status, custom_status_emoji: s.custom_status_emoji });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Object URLs are a manual allocation; drop them when the tab goes away.
  useEffect(() => () => {
    Object.values(preview).forEach((url) => url && URL.revokeObjectURL(url));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const original = readProfile(currentUser);
  const baseDirty = Object.keys(original).some((key) => form[key] !== original[key]);
  const identDirty = Boolean(identitySaved) && IDENTITY_KEYS.some((k) => !same(ident[k], identitySaved[k]));
  const dirty = baseDirty || identDirty;
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const setI = (patch) => setIdent((current) => ({ ...current, ...patch }));
  useReportDirty(dirty, onDirtyChange);

  // Follow an external change (another device, a socket update) — but never
  // while there are local edits waiting to be saved.
  useEffect(() => {
    if (baseDirty) return;
    setForm(readProfile(currentUser));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, currentUser?.display_name, currentUser?.pronouns, currentUser?.bio,
      currentUser?.avatar_url, currentUser?.banner_url, currentUser?.accent_color]);

  useEffect(() => {
    const beforeUnload = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const pickImage = (kind, file, inputRef) => {
    // Reset the input first: without this, choosing the *same* file twice fires
    // no change event, so a retry after an error looks like a dead button.
    if (inputRef?.current) inputRef.current.value = '';
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      onToast?.(t('settings.uploadWrongType'), { type: 'error' });
      return;
    }
    if (file.size > MAX_BYTES[kind]) {
      onToast?.(t('settings.uploadTooLarge', { limit: Math.round(MAX_BYTES[kind] / 1024 / 1024) }), { type: 'error' });
      return;
    }
    // Crop first (client-side canvas); animated files can skip it and keep moving.
    setCropping({ kind, file });
  };

  const uploadImage = async (kind, file) => {
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

  const finishCrop = (blob) => {
    const { kind, file } = cropping;
    setCropping(null);
    if (!blob) { uploadImage(kind, file); return; }
    const ext = blob.type === 'image/webp' ? 'webp' : 'png';
    uploadImage(kind, new File([blob], `${kind}.${ext}`, { type: blob.type }));
  };

  /** Drop the local previews; afterwards the form's URLs are what shows. */
  const clearPreviews = () => setPreview((current) => {
    Object.values(current).forEach((url) => url && URL.revokeObjectURL(url));
    return { avatar: null, banner: null };
  });

  // Reset has to drop the previews too: they take precedence over the form's
  // URL, so a reset used to leave the freshly picked picture on screen.
  const reset = () => {
    clearPreviews();
    setForm(readProfile(currentUser));
    if (identitySaved) setIdent(identitySaved);
  };

  const clearImage = (kind) => {
    setPreview((current) => {
      if (current[kind]) URL.revokeObjectURL(current[kind]);
      return { ...current, [kind]: null };
    });
    set({ [kind === 'avatar' ? 'avatar_url' : 'banner_url']: '' });
  };

  // What to show: the local file while it uploads, otherwise the saved URL.
  const avatarSrc = preview.avatar ?? (proxiedImageUrl(form.avatar_url) || DEFAULT_AVATAR);
  const bannerSrc = preview.banner ?? proxiedImageUrl(form.banner_url);

  const save = async () => {
    setBusy(true);
    try {
      if (baseDirty) {
        await onSaveProfile({
          display_name: form.display_name.trim() || currentUser?.username,
          pronouns: form.pronouns.trim() || null,
          bio: form.bio.trim() || null,
          avatar_url: form.avatar_url || null,
          banner_url: form.banner_url || null,
          accent_color: form.accent_color
        });
      }
      if (identDirty) {
        const patch = {};
        for (const k of IDENTITY_KEYS) if (!same(ident[k], identitySaved[k])) patch[k] = ident[k];
        const result = await updateMyIdentity(patch);
        setIdentitySaved(readIdentity(result));
        setIdent(readIdentity(result));
        setWearable(result.wearable_tags ?? wearable);
      }
      announceLocalIdentityChange(currentUser?.id);
      clearPreviews();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // The draft as the card renders it.
  const itemsById = useMemo(() => {
    const map = new Map();
    for (const list of Object.values(catalogue)) for (const item of list) map.set(item.id, item);
    return map;
  }, [catalogue]);
  const wornTag = wearable.find((w) => w.server_id === ident.primary_server_tag_id);
  const draftIdentity = {
    ...(liveIdentity ?? {}),
    decoration: itemsById.get(ident.avatar_decoration_id) ?? null,
    effect: itemsById.get(ident.profile_effect_id) ?? null,
    nameplate: itemsById.get(ident.nameplate_id) ?? null,
    frame: itemsById.get(ident.profile_frame_id) ?? null,
    name_style: ident.name_style,
    theme_colors: ident.theme_colors,
    tag: wornTag ? { ...wornTag } : null,
    badges: liveIdentity?.badges ?? [],
    new_member: false
  };
  const draftUser = {
    ...statusExtra,
    ...currentUser,
    custom_status: currentUser?.custom_status ?? statusExtra.custom_status ?? null,
    custom_status_emoji: currentUser?.custom_status_emoji ?? statusExtra.custom_status_emoji ?? null,
    display_name: form.display_name || currentUser?.username,
    pronouns: form.pronouns,
    bio: form.bio,
    accent_color: form.accent_color,
    status: currentUser?.status ?? 'online'
  };

  /** Wrap the bio selection in markdown (B / I / S / spoiler / link). */
  const format = (before, after = before, placeholder = '') => {
    const el = bioRef.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const chosen = value.slice(a, b) || placeholder;
    const next = `${value.slice(0, a)}${before}${chosen}${after}${value.slice(b)}`;
    if (next.length > BIO_MAX) return;
    set({ bio: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + before.length, a + before.length + chosen.length);
    });
  };

  const kinds = [
    { key: 'avatar_decoration', label: t('profiles.kind.avatar_decoration') },
    { key: 'profile_effect', label: t('profiles.kind.profile_effect') },
    { key: 'nameplate', label: t('profiles.kind.nameplate') },
    { key: 'profile_frame', label: t('profiles.kind.profile_frame') }
  ];

  return (
    <div className="relative pb-24">
      <PageHeader title={t('settings.profileTitle')} description={t('settings.profileLead')} />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* --- fields ------------------------------------------------------- */}
        <div className="min-w-0 space-y-4">
          <Field label={t('settings.displayName')} htmlFor="profile-display-name">
            <input
              id="profile-display-name"
              value={form.display_name}
              onChange={(event) => set({ display_name: event.target.value })}
              maxLength={32}
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

          <Field label={t('settings.aboutMe')} htmlFor="profile-bio" hint={t('profiles.bioHint')}>
            <div className="mb-1 flex gap-1" role="toolbar" aria-label={t('profiles.formatting')}>
              {[
                { icon: Bold, label: t('profiles.fmtBold'), run: () => format('**') },
                { icon: Italic, label: t('profiles.fmtItalic'), run: () => format('*') },
                { icon: Strikethrough, label: t('profiles.fmtStrike'), run: () => format('~~') },
                { icon: EyeOff, label: t('profiles.fmtSpoiler'), run: () => format('||') },
                { icon: Link2, label: t('profiles.fmtLink'), run: () => format('[', '](https://)', t('profiles.fmtLinkText')) }
              ].map((tool) => {
                const Icon = tool.icon;
                return (
                  <button key={tool.label} type="button" onClick={tool.run} aria-label={tool.label} title={tool.label}
                    className="flex h-8 w-8 items-center justify-center rounded text-d-text2 hover:bg-d-hover hover:text-d-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
            <textarea
              id="profile-bio"
              ref={bioRef}
              value={form.bio}
              onChange={(event) => set({ bio: event.target.value })}
              rows={5}
              maxLength={BIO_MAX}
              className={`${inputClass} resize-y`}
            />
            <span className="mt-1 block text-right text-xs text-d-text4 tabular-nums" aria-live="polite">
              {form.bio.length}/{BIO_MAX}
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
            <p className="mt-2 text-xs text-d-text3">{t('profiles.animatedHint')}</p>
            <input
              ref={avatarInput}
              type="file"
              accept={ACCEPTED.join(',')}
              className="hidden"
              aria-label={t('settings.avatar')}
              onChange={(event) => pickImage('avatar', event.target.files?.[0], avatarInput)}
            />
          </Section>

          <Section title={t('settings.banner')}>
            <button
              type="button"
              onClick={() => bannerInput.current?.click()}
              aria-label={t('settings.changeBanner')}
              className="group relative block aspect-[5/2] max-h-32 w-full overflow-hidden rounded-lg border
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

          <Section title={t('profiles.themeTitle')} description={t('profiles.themeLead')}>
            <ThemeColorsEditor value={ident.theme_colors} onChange={(v) => setI({ theme_colors: v })} />
          </Section>

          <Section title={t('profiles.nameStyleTitle')} description={t('profiles.nameStyleLead')}>
            <NameStyleEditor value={ident.name_style} onChange={(v) => setI({ name_style: v })}
              sample={form.display_name || currentUser?.username} />
          </Section>

          <Divider />

          <Section title={t('profiles.collectiblesTitle')} description={t('profiles.collectiblesLead')}>
            <div className="mb-3 overflow-x-auto">
              <Segmented value={kindTab} onChange={setKindTab} options={kinds} label={t('profiles.collectiblesTitle')} />
            </div>
            <CosmeticPicker
              kind={kindTab}
              items={catalogue[kindTab]}
              value={ident[KIND_FIELD[kindTab]]}
              onChange={(id) => setI({ [KIND_FIELD[kindTab]]: id })}
              avatarSrc={avatarSrc}
              label={kinds.find((k) => k.key === kindTab)?.label}
            />
          </Section>

          <Section title={t('profiles.serverTagTitle')} description={t('profiles.serverTagLead')}>
            {wearable.length === 0 ? (
              <p className="text-sm text-d-text3">{t('profiles.noWearableTags')}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Select id="profile-tag" label={t('profiles.serverTagTitle')}
                  value={ident.primary_server_tag_id ?? ''}
                  onChange={(value) => setI({ primary_server_tag_id: value || null })}>
                  <option value="">{t('profiles.noTag')}</option>
                  {wearable.map((w) => <option key={w.server_id} value={w.server_id}>{`${w.tag} — ${w.server_name}`}</option>)}
                </Select>
                {wornTag && <ServerTagChip tag={wornTag} size="lg" />}
              </div>
            )}
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

          <Divider />

          <Section title={t('profiles.viewingTitle')} description={t('profiles.viewingLead')}>
            <Field label={t('profiles.viewDecorations')} htmlFor="profiles-view-deco">
              <Select id="profiles-view-deco" label={t('profiles.viewDecorations')} value={viewer.decorations}
                onChange={(value) => setViewerPrefs({ decorations: value })}>
                <option value="animate">{t('profiles.viewAnimate')}</option>
                <option value="hover">{t('profiles.viewHover')}</option>
                <option value="off">{t('profiles.viewOff')}</option>
              </Select>
            </Field>
            <SettingToggle label={t('profiles.viewEffects')} checked={viewer.effects}
              onChange={(v) => setViewerPrefs({ effects: v })} />
            <SettingToggle label={t('profiles.viewNameStyles')} checked={viewer.nameStyles}
              onChange={(v) => setViewerPrefs({ nameStyles: v })} />
            <SettingToggle label={t('profiles.viewNameStylesLists')} hint={t('profiles.viewNameStylesListsHint')}
              checked={viewer.nameStylesInLists} disabled={!viewer.nameStyles}
              onChange={(v) => setViewerPrefs({ nameStylesInLists: v })} />
            <SettingToggle label={t('profiles.viewColors')} hint={viewer.highContrast ? t('profiles.viewColorsHighContrast') : undefined}
              checked={viewer.profileColors} disabled={viewer.highContrast}
              onChange={(v) => setViewerPrefs({ profileColors: v })} last />
          </Section>
        </div>

        {/* --- live preview -------------------------------------------------- */}
        <div className="lg:sticky lg:top-15 lg:self-start">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-[0.02em] text-d-text2">
            {t('settings.preview')}
          </h3>
          <ProfilePreview user={draftUser} identity={draftIdentity} avatarSrc={avatarSrc} bannerSrc={bannerSrc || null} />
        </div>
      </div>

      {cropping && (
        <CropDialog file={cropping.file} kind={cropping.kind} onCancel={() => setCropping(null)} onDone={finishCrop} />
      )}

      {/* --- unsaved changes bar --------------------------------------------- */}
      {dirty && (
        <UnsavedBar
          nudge={nudge}
          onReset={reset}
          onSave={save}
          saving={busy}
          // Saving mid-upload would send the old picture and drop the new one.
          saveDisabled={Boolean(uploading)}
        />
      )}
      {saved && !dirty && (
        <p role="status" className="sticky bottom-4 mt-8 flex items-center gap-2 text-sm font-medium text-d-success">
          <Check className="h-4 w-4" /> {t('common.saved')}
        </p>
      )}
    </div>
  );
}
