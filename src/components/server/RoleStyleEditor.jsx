import React, { useId, useMemo, useRef, useState } from 'react';
import { Upload, Smile, Trash2, AlertTriangle, Loader2 } from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import { upload as httpUpload, api as httpApi } from '../../api';
import EmojiPicker from '../EmojiPicker';
import { ToggleRow } from '../ui';
import { updatePreferences, getPreferences } from '../../hooks/useUserSettings';
import { ROLE_COLOR_PRESETS } from '../../utils/permissionCatalog';
import RoleIcon, { useShowRoleIcons } from './RoleIcon.jsx';
import { roleNameStyle, worstStopContrast, styleOf, DEFAULT_ROLE_COLOR } from './roleStyle';

const PREVIEW_SURFACES = [
  { key: 'dark', background: '#1c1c20', panel: 'bg-[#1c1c20]', text: 'text-[#dbdee1]' },
  { key: 'light', background: '#fbfbfc', panel: 'bg-[#fbfbfc]', text: 'text-[#313338]' }
];
const ICON_MAX_BYTES = 256 * 1024;
const ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** A colour row: presets plus a custom picker and hex field. */
function ColourPicker({ value, onChange, label }) {
  const id = useId();
  const [text, setText] = useState(value ?? '');
  React.useEffect(() => { setText(value ?? ''); }, [value]);
  return (
    <div role="group" aria-label={label}>
      <div className="flex flex-wrap items-center gap-1.5">
        {ROLE_COLOR_PRESETS.map((colour) => (
          <button
            key={colour}
            type="button"
            onClick={() => onChange(colour)}
            style={{ backgroundColor: colour }}
            aria-pressed={value === colour}
            aria-label={t('roles.colorSwatch', { color: colour })}
            className={`w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 rounded border border-black/20 ${value === colour ? 'ring-2 ring-d-strong ring-offset-1 ring-offset-d-canvas' : ''}`}
          />
        ))}
        <label htmlFor={`${id}-native`} className="sr-only">{t('srv.customColour')}</label>
        <input
          id={`${id}-native`}
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value ?? '') ? value : DEFAULT_ROLE_COLOR}
          onChange={(e) => onChange(e.target.value)}
          className="w-8 h-7 p-0 bg-transparent border border-d-divider rounded cursor-pointer"
        />
        <input
          aria-label={t('srv.hexColour', { label })}
          value={text}
          maxLength={7}
          spellCheck={false}
          onChange={(e) => {
            const next = e.target.value.trim();
            setText(next);
            if (/^#?[0-9a-f]{6}$/i.test(next)) onChange(`#${next.replace('#', '').toLowerCase()}`);
          }}
          className="w-24 bg-d-base text-xs text-d-strong font-mono px-2 py-1.5 rounded border border-d-edge focus:outline-none focus:border-d-brand"
        />
      </div>
    </div>
  );
}

/**
 * The Display section of a role in Server Settings › Roles: colour, name
 * style (solid / gradient / holographic, with the gradient's angle), role icon
 * (upload or emoji), a live preview on dark and light, and a contrast note
 * when the guard is adjusting the chosen colours.
 *
 * `draft` / `setDraft` are the Roles tab's unsaved role; the icon is saved
 * straight away (it is an upload), through `onIconSaved(role)`.
 */
export default function RoleStyleEditor({ draft, setDraft, serverId, onIconSaved, onToast }) {
  const style = styleOf(draft);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const previewRef = useRef(null);
  const showIcons = useShowRoleIcons();
  const angleId = useId();

  const worst = useMemo(
    () => Math.min(...PREVIEW_SURFACES.map((s) => worstStopContrast(draft, s.background) ?? 21)),
    [draft]
  );

  // Picking a style is about how the name looks: bring the preview into view.
  // The settings page keeps a bottom scroll padding the size of the unsaved-
  // changes bar, so "nearest" lands the preview above the bar, not under it.
  const revealPreview = () => requestAnimationFrame(() => {
    const reduce = Boolean(getPreferences().accessibility?.reducedMotion)
      || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    previewRef.current?.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  });

  const setStyle = (next) => {
    revealPreview();
    if (next === 'solid') setDraft({ ...draft, style: 'solid', color_secondary: null });
    else setDraft({
      ...draft,
      style: next,
      color: draft.color || '#5865f2',
      color_secondary: next === 'gradient' ? (draft.color_secondary || '#eb459e') : (draft.color_secondary ?? null),
      gradient_angle: draft.gradient_angle ?? 90
    });
  };

  const onStyleKey = (e) => {
    const order = ['solid', 'gradient', 'holographic'];
    const at = order.indexOf(style);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setStyle(order[(at + 1) % 3]); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setStyle(order[(at + 2) % 3]); }
  };

  const uploadIcon = async (input) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!ICON_TYPES.includes(file.type)) { onToast?.(t('srv.roleIconType'), { type: 'error' }); return; }
    if (file.size > ICON_MAX_BYTES) { onToast?.(t('srv.roleIconTooLarge'), { type: 'error' }); return; }
    setBusy(true);
    try {
      const role = await httpUpload(`/api/servers/${serverId}/roles/${draft.id}/icon`, 'icon', file);
      onIconSaved?.(role);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally { setBusy(false); }
  };

  const saveEmoji = async (emoji) => {
    setPicking(false);
    setBusy(true);
    try {
      const role = await httpApi(`/api/servers/${serverId}/roles/${draft.id}`, { method: 'PATCH', body: { unicode_emoji: emoji } });
      onIconSaved?.(role);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally { setBusy(false); }
  };

  const removeIcon = async () => {
    setBusy(true);
    try {
      const role = draft.unicode_emoji
        ? await httpApi(`/api/servers/${serverId}/roles/${draft.id}`, { method: 'PATCH', body: { unicode_emoji: null } })
        : await httpApi(`/api/servers/${serverId}/roles/${draft.id}/icon`, { method: 'DELETE' });
      onIconSaved?.(role);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally { setBusy(false); }
  };

  const hasIcon = Boolean(draft.icon_url || draft.unicode_emoji);
  const label = 'block text-[11px] font-bold text-d-text2 uppercase mb-1.5';

  return (
    <div className="mt-4 space-y-4">
      <div>
        <span className={label}>{t('roles.roleColour')}</span>
        <ColourPicker value={draft.color} onChange={(color) => setDraft({ ...draft, color })} label={t('roles.roleColour')} />
      </div>

      <fieldset>
        <legend className={label}>{t('adm.roleStyle')}</legend>
        <div role="radiogroup" aria-label={t('adm.roleStyle')} className="flex flex-wrap gap-2" onKeyDown={onStyleKey}>
          {[
            ['solid', t('adm.roleStyleSolid')],
            ['gradient', t('adm.roleStyleGradient')],
            ['holographic', t('srv.roleStyleHolographic')]
          ].map(([key, text]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={style === key}
              tabIndex={style === key ? 0 : -1}
              onClick={() => setStyle(key)}
              className={`min-h-[32px] px-3 py-1 rounded-full text-sm border ${style === key
                ? 'bg-d-brand border-d-brand text-white'
                : 'border-d-divider text-d-text2 hover:bg-d-hover'}`}
            >
              {text}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-d-text2">{t('srv.roleStyleFree')}</p>
      </fieldset>

      {style !== 'solid' && (
        <div>
          <span className={label}>{style === 'gradient' ? t('adm.secondColour') : t('srv.holoTint')}</span>
          <ColourPicker
            value={draft.color_secondary}
            onChange={(color_secondary) => setDraft({ ...draft, color_secondary })}
            label={style === 'gradient' ? t('adm.secondColour') : t('srv.holoTint')}
          />
        </div>
      )}

      {style === 'gradient' && (
        <div>
          <label htmlFor={angleId} className={label}>{t('srv.gradientAngle', { angle: draft.gradient_angle ?? 90 })}</label>
          <input
            id={angleId}
            type="range"
            min={0}
            max={360}
            step={15}
            value={draft.gradient_angle ?? 90}
            onChange={(e) => setDraft({ ...draft, gradient_angle: Number(e.target.value) })}
            aria-valuetext={`${draft.gradient_angle ?? 90}°`}
            className="w-full max-w-xs accent-[var(--color-d-brand)]"
          />
        </div>
      )}

      <div>
        <span className={label}>{t('srv.roleIcon')}</span>
        <div className="flex flex-wrap items-center gap-2 relative">
          <span className="w-10 h-10 rounded-md bg-d-surface border border-d-divider flex items-center justify-center">
            {hasIcon ? <RoleIcon role={draft} size={24} force /> : <Smile className="w-5 h-5 text-d-text3" aria-hidden="true" />}
          </span>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy || !draft.id}
            className="min-h-[32px] inline-flex items-center gap-1.5 px-3 rounded bg-d-control hover:bg-d-control2 text-sm text-d-strong disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Upload className="w-4 h-4" aria-hidden="true" />}
            {t('srv.uploadImage')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ICON_TYPES.join(',')}
            className="hidden"
            aria-label={t('srv.roleIcon')}
            onChange={(e) => uploadIcon(e.target)}
          />
          <button
            type="button"
            onClick={() => setPicking((v) => !v)}
            aria-expanded={picking}
            disabled={busy}
            className="min-h-[32px] inline-flex items-center gap-1.5 px-3 rounded bg-d-control hover:bg-d-control2 text-sm text-d-strong disabled:opacity-50"
          >
            <Smile className="w-4 h-4" aria-hidden="true" /> {t('srv.pickEmoji')}
          </button>
          {hasIcon && (
            <button
              type="button"
              onClick={removeIcon}
              disabled={busy}
              className="min-h-[32px] inline-flex items-center gap-1.5 px-3 rounded text-sm text-d-danger hover:bg-d-danger/10"
            >
              <Trash2 className="w-4 h-4" aria-hidden="true" /> {t('common.remove')}
            </button>
          )}
          {picking && (
            <EmojiPicker
              anchorClass="absolute left-0 top-full mt-1 z-30"
              onClose={() => setPicking(false)}
              onPick={(entry) => { if (entry.char) saveEmoji(entry.char); }}
            />
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-d-text2">{t('srv.roleIconHint')}</p>
      </div>

      <div ref={previewRef} className="scroll-mb-4">
        <span className={label}>{t('srv.preview')}</span>
        <div className="grid sm:grid-cols-2 gap-2">
          {PREVIEW_SURFACES.map((surface) => {
            const look = roleNameStyle(draft, { background: surface.background });
            return (
              <div key={surface.key} className={`rounded-md p-3 border border-d-divider ${surface.panel}`}>
                <span className={`block text-[10px] uppercase font-bold mb-1 ${surface.text} opacity-80`}>
                  {surface.key === 'dark' ? t('srv.previewDark') : t('srv.previewLight')}
                </span>
                <span className="flex items-center gap-2">
                  <span className="w-8 h-8 rounded-full bg-d-brand shrink-0" aria-hidden="true" />
                  <span className="inline-flex items-center gap-1 text-[15px] font-medium min-w-0">
                    <span className={`truncate ${look.className}`} style={look.style}>{draft.name || t('roles.newRoleName')}</span>
                    {hasIcon && <RoleIcon role={draft} size={16} force />}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        {worst < 4.5 && (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-d-text2">
            <AlertTriangle className="w-3.5 h-3.5 text-d-idle shrink-0 mt-0.5" aria-hidden="true" />
            {t('srv.contrastAdjusted')}
          </p>
        )}
        <div className="mt-2 max-w-md">
          <ToggleRow
            checked={showIcons}
            onChange={(v) => updatePreferences('appearance', { showRoleIcons: v })}
            label={t('srv.showRoleIcons')}
            hint={t('srv.showRoleIconsHint')}
          />
        </div>
      </div>
    </div>
  );
}
