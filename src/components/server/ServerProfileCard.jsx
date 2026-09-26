import React from 'react';
import { Loader2, Check } from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import { proxiedImageUrl } from '../../utils/media';
import { serverInitials } from '../../utils/avatar';
import { Button } from '../ui';
import AnimatedServerIcon from './AnimatedServerIcon.jsx';

const fmt = (n) => {
  try { return new Intl.NumberFormat(undefined, { notation: n >= 10000 ? 'compact' : 'standard' }).format(n); }
  catch { return String(n); }
};

/**
 * A server's public face — banner (or accent colour), icon, name, description,
 * online / member counts and up to five traits — used by Discover, the invite
 * page and anywhere a server is introduced before you join it.
 *
 * `profile` is the shape GET /api/servers/:id/profile returns.
 * `actionLabel` + `onAction` render the primary button (Join, Accept invite);
 * a profile with `joined` shows "Joined" and calls `onOpen` instead.
 */
export default function ServerProfileCard({
  profile, actionLabel, onAction, onOpen, busy = false, headingLevel = 3, compact = false, className = ''
}) {
  if (!profile) return null;
  const Heading = `h${headingLevel}`;
  const accent = /^#[0-9a-f]{6}$/i.test(profile.accent_color ?? '') ? profile.accent_color : null;
  const banner = profile.banner_url ? proxiedImageUrl(profile.banner_url) : null;
  const icon = profile.icon_url ? proxiedImageUrl(profile.icon_url) : null;
  const titleId = `spc-${profile.id}`;

  return (
    <article
      aria-labelledby={titleId}
      className={`flex flex-col overflow-hidden rounded-lg bg-d-surface border border-d-divider shadow-sm ${className}`}
    >
      <div
        className={`relative ${compact ? 'h-20' : 'h-28'} shrink-0 bg-d-brand`}
        data-custom-color={accent ? '' : undefined}
        style={accent ? { backgroundColor: accent } : undefined}
      >
        {banner && (
          <AnimatedServerIcon
            src={banner}
            animated={Boolean(profile.banner_animated)}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
      </div>
      <div className="relative px-4 pb-4 flex-1 flex flex-col">
        <div className="-mt-8 mb-2 w-16 h-16 rounded-[20px] border-4 border-d-surface bg-d-surface overflow-hidden shrink-0">
          {icon ? (
            <AnimatedServerIcon src={icon} animated={Boolean(profile.icon_animated)} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="w-full h-full bg-d-brand text-white text-lg font-semibold flex items-center justify-center" aria-hidden="true">
              {serverInitials(profile.name)}
            </span>
          )}
        </div>
        <Heading id={titleId} className="text-base font-bold text-d-strong leading-snug break-words">{profile.name}</Heading>
        {Boolean(profile.description) && (
          <p className={`mt-1 text-sm text-d-text2 leading-snug break-words ${compact ? 'line-clamp-2' : 'line-clamp-3'}`}>
            {profile.description}
          </p>
        )}
        {profile.traits?.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t('srv.traits')}>
            {profile.traits.map((trait, i) => (
              <li key={`${trait.label}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-d-base px-2 py-0.5 text-xs text-d-text">
                {trait.emoji && <span aria-hidden="true">{trait.emoji}</span>}
                {trait.label}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-auto pt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-d-text2">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-d-online" aria-hidden="true" />
            {t('srv.onlineCount', { n: fmt(profile.online_count ?? 0) })}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-d-text3" aria-hidden="true" />
            {t('srv.memberCount', { n: fmt(profile.member_count ?? 0) })}
          </span>
          {profile.discovery_category && (
            <span className="text-d-text3">{t(`srv.category.${profile.discovery_category}`)}</span>
          )}
        </div>
        {(actionLabel || profile.joined) && (
          <div className="mt-3">
            {profile.joined ? (
              <Button variant="secondary" size="sm" block onClick={onOpen} disabled={!onOpen}
                aria-label={t('srv.openServer', { name: profile.name })}>
                <Check className="w-4 h-4" aria-hidden="true" /> {t('srv.joined')}
              </Button>
            ) : (
              <Button variant="success" size="sm" block onClick={onAction} disabled={busy}
                aria-label={`${actionLabel} — ${profile.name}`}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                {actionLabel}
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
