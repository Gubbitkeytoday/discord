import React from 'react';
import { RotateCcw } from 'lucide-react';
import AvatarWithDecoration from './AvatarWithDecoration';
import ProfileEffect, { ProfileFrame } from './ProfileEffect';
import DisplayName from './DisplayName';
import BadgeRow from './BadgeRow';
import { profileTheme } from '../../profile/theme';
import { useViewerPrefs } from '../../profile/motion';
import { StatusEmoji } from '../../profile/text.jsx';
import { cssImageUrl } from '../../utils/media';
import { t } from '../../i18n/index.jsx';

const SIZES = {
  popout: { banner: 'h-[105px]', avatar: 80, lift: '-mt-10' },
  preview: { banner: 'h-[88px]', avatar: 72, lift: '-mt-9' },
  full: { banner: 'h-[150px]', avatar: 112, lift: '-mt-14' }
};

/**
 * The shared profile card: theme gradient, banner, decorated avatar, profile
 * effect and frame, styled name, tag, badges and custom-status bubble. Used by
 * the popout, the full profile and the editor's live preview, so what you
 * preview is exactly what others see.
 *
 * Stable API:
 *   user        { id, username, display_name, avatar_url, banner_url, accent_color,
 *                 pronouns, status, custom_status, custom_status_emoji }
 *   identity    from useIdentity() / GET /api/profiles/:id (may be null)
 *   member      optional server member { nickname, avatar_url }
 *   variant     'popout' | 'full' | 'preview'
 *   usernameText  what to print after "@" (streamer mode may mask it)
 *   headerSlot  content drawn over the banner's top-right corner (close button…)
 *   replay / onReplay  restart the profile effect
 *   children    the body under the name (bio, tabs, actions…)
 */
export default function ProfileCard({
  user, identity = null, member = null, variant = 'popout', usernameText, roleColor = null,
  avatarSrc, bannerSrc, headerSlot = null, replay = 0, onReplay = null, className = '', children
}) {
  const viewer = useViewerPrefs();
  const size = SIZES[variant] ?? SIZES.popout;
  const theme = viewer.profileColors ? profileTheme(identity?.theme_colors) : null;
  const avatar = avatarSrc ?? member?.avatar_url ?? user?.avatar_url;
  const banner = bannerSrc !== undefined ? bannerSrc : (member?.banner_url ?? user?.banner_url);
  const name = member?.nickname || user?.display_name || user?.username;
  const ringColor = theme ? theme.primary : 'var(--color-d-panel)';
  const themedVars = theme ? {
    ...theme.style,
    '--color-d-strong': 'var(--pf-fg)',
    '--color-d-text': 'var(--pf-fg)',
    '--color-d-text2': 'var(--pf-fg-muted)',
    '--color-d-text3': 'var(--pf-fg-muted)',
    '--color-d-text4': 'var(--pf-fg-muted)',
    '--color-d-divider': 'var(--pf-divider)',
    '--color-d-surface': 'var(--pf-panel)',
    '--color-d-sunken': 'var(--pf-panel)',
    '--color-d-input': 'var(--pf-panel)',
    '--color-d-hover': 'var(--pf-divider)',
    '--color-d-link': 'var(--pf-fg)'
  } : null;
  const hasStatus = Boolean(user?.custom_status || user?.custom_status_emoji);

  return (
    <div
      className={`relative isolate overflow-hidden rounded-xl ${theme ? '' : 'bg-d-panel'} ${className}`}
      style={themedVars ?? undefined}
      data-profile-card={variant}
      data-themed={theme ? (theme.dark ? 'light-text' : 'dark-text') : undefined}
    >
      <ProfileEffect item={identity?.effect} replay={replay} />
      <ProfileFrame item={identity?.frame} />

      <div
        className={`${size.banner} relative bg-cover bg-center`}
        style={{
          backgroundImage: banner ? cssImageUrl(banner) : undefined,
          backgroundColor: theme?.primary ?? user?.accent_color ?? 'var(--color-d-brand)'
        }}
      >
        {headerSlot && <div className="absolute right-2 top-2 z-[4] flex gap-1.5">{headerSlot}</div>}
        {onReplay && identity?.effect && (
          <button
            type="button"
            onClick={onReplay}
            aria-label={t('profiles.replayEffect')}
            title={t('profiles.replayEffect')}
            className="absolute left-2 top-2 z-[4] flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Above the effect layer (z-[2]): lanterns, petals and sparkles play
          over the banner and the card's edges, never across the name. */}
      <div className="relative z-[3] px-4 pb-4">
        <div className={`${size.lift} flex items-end justify-between gap-2`}>
          <div className="flex min-w-0 items-start gap-2">
            <span className="rounded-full" style={{ padding: 5, background: ringColor }}>
              <AvatarWithDecoration
                src={avatar}
                userId={user?.id}
                size={size.avatar}
                decoration={identity?.decoration}
                context="profile"
                status={user?.status ?? null}
                ring={ringColor}
              />
            </span>
            {hasStatus && variant !== 'full' && (
              <p className="pf-bubble mt-12 line-clamp-2 max-w-[11rem] rounded-2xl border border-d-divider bg-d-sunken px-2.5 py-1.5 text-xs text-d-text shadow-sm"
                style={theme ? { background: 'var(--pf-panel)' } : undefined}>
                <StatusEmoji emoji={user.custom_status_emoji} className="mr-1 inline h-4 w-4 align-text-bottom" />
                {user.custom_status}
              </p>
            )}
          </div>
          <BadgeRow badges={identity?.badges} className="mb-1 justify-end" />
        </div>

        <div className="mt-3 rounded-lg px-3 py-2.5"
          style={{ background: theme ? 'var(--pf-panel)' : 'var(--color-d-sunken)' }}>
          <h2 className={`${variant === 'full' ? 'text-2xl' : 'text-xl'} font-bold leading-tight text-d-strong`}>
            <DisplayName name={name} identity={identity} roleColor={roleColor} interactive
              background={theme ? (theme.dark ? '#16181d' : '#eef0f3') : undefined} />
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-d-text2">
            <span>{usernameText ?? `@${user?.username ?? ''}`}</span>
            {Boolean(user?.pronouns) && <><span aria-hidden="true">•</span><span>{user.pronouns}</span></>}
          </p>
          {hasStatus && variant === 'full' && (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-d-text">
              <StatusEmoji emoji={user.custom_status_emoji} />
              <span>{user.custom_status}</span>
            </p>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
