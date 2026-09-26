import React from 'react';
import { Hash, Plus, Smile } from 'lucide-react';
import { t, localeTag } from '../../i18n/index.jsx';
import { defaultAvatar } from '../../utils/avatar';
import { readableRoleColor } from '../../utils/color';

/**
 * A miniature of the app — rail, channel list, chat and composer — drawn
 * with the real surface classes, message classes and tokens. Theme,
 * gradient, density, corners, font, chat size and text spacing all apply to
 * it exactly as to the app around it, because it IS the app's CSS.
 */
export default function ThemePreview({ messageDisplay = 'cozy', use24HourClock = true }) {
  const time = new Date(2026, 0, 1, 13, 37).toLocaleTimeString(localeTag(), {
    hour: 'numeric', minute: '2-digit', hour12: !use24HourClock
  });
  const rows = [
    { name: 'Kira', colour: '#f0b232', text: t('theme.previewOne') },
    { name: 'Niran', colour: '#3ba55c', text: t('theme.previewTwo'), link: true },
    { name: 'Alex', colour: '#5865f2', text: t('theme.previewThree'), mention: true }
  ];

  return (
    <figure className="m-0">
      <figcaption className="mb-2 text-xs font-bold uppercase tracking-[0.02em] text-d-text2">
        {t('appearance.preview')}
      </figcaption>
      <p className="sr-only">{t('theme.previewSr')}</p>
      <div
        aria-hidden="true"
        className="flex h-80 overflow-hidden rounded-lg border border-d-divider bg-d-base text-left select-none"
      >
        {/* server rail */}
        <div className="flex w-12 shrink-0 flex-col items-center gap-2 bg-d-base py-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-d-brand text-xs font-bold text-white">A</span>
          <span className="h-0.5 w-5 rounded bg-d-divider" />
          <span className="h-8 w-8 rounded-full bg-d-control2" />
          <span className="h-8 w-8 rounded-full bg-d-control2" />
          <span className="season-art !mt-auto !mb-1 !h-6 !w-6" />
        </div>
        {/* channel list */}
        <div className="flex w-28 shrink-0 flex-col bg-d-surface lg:hidden">
          <div className="flex h-9 items-center border-b border-d-divider px-2 text-xs font-semibold text-d-strong">
            Antigravity
          </div>
          <div className="space-y-0.5 p-1.5 text-xs">
            <div className="flex items-center gap-1 rounded bg-d-active px-1.5 py-1 font-medium text-d-strong">
              <Hash className="h-3 w-3 shrink-0" /> <span className="truncate">{t('theme.previewChannel')}</span>
            </div>
            <div className="flex items-center gap-1 rounded px-1.5 py-1 text-d-text3">
              <Hash className="h-3 w-3 shrink-0" /> <span className="truncate">{t('theme.previewChannelTwo')}</span>
            </div>
            <div className="flex items-center gap-1 rounded bg-d-hover px-1.5 py-1 text-d-text2">
              <Hash className="h-3 w-3 shrink-0" /> <span className="truncate">{t('theme.previewChannelThree')}</span>
            </div>
          </div>
        </div>
        {/* chat */}
        <div className="flex min-w-0 flex-1 flex-col bg-d-canvas">
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-d-divider px-3 text-xs font-semibold text-d-strong">
            <Hash className="h-3.5 w-3.5 text-d-text3" /> {t('theme.previewChannel')}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden px-1 pt-1">
            {rows.map((row, index) => (
              <div
                key={row.name}
                className={`message-row flex gap-2 rounded px-2 ${row.mention ? 'mention-row' : ''} ${index > 0 ? 'message-group-start' : ''}`}
                style={{ paddingTop: 'var(--message-padding-y)', paddingBottom: 'var(--message-padding-y)' }}
              >
                {messageDisplay === 'cozy' && (
                  <img src={defaultAvatar(row.name)} alt="" width={28} height={28} className="mt-0.5 h-7 w-7 shrink-0 rounded-full" />
                )}
                <div className="min-w-0">
                  <span className="role-colored mr-1.5 text-xs font-semibold" style={{ color: readableRoleColor(row.colour) ?? undefined }}>
                    {row.name}
                  </span>
                  <span className="text-[11px] text-d-text3">{time}</span>
                  <p className="message-body m-0 break-words text-d-text">
                    {row.mention && <span className="rounded bg-d-brand/20 px-0.5 font-medium text-d-brandtext">@you </span>}
                    {row.text}
                    {row.link && <> <a href="#preview" tabIndex={-1} className="text-d-link" onClick={(e) => e.preventDefault()}>antigravity.chat</a></>}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div className="m-2 mt-1 flex shrink-0 items-center gap-2 rounded-lg bg-d-input px-2 py-1.5 text-xs text-d-text4">
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t('theme.previewComposer')}</span>
            <Smile className="h-3.5 w-3.5 shrink-0" />
          </div>
        </div>
      </div>
    </figure>
  );
}
