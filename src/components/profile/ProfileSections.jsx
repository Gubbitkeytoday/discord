import React, { useLayoutEffect, useRef, useState } from 'react';
import { renderBio } from '../../profile/text.jsx';
import { localeTag, t } from '../../i18n/index.jsx';

/** Section heading used inside profile cards. */
export function SectionTitle({ children, id }) {
  return <h3 id={id} className="mb-1 text-xs font-bold uppercase tracking-wide text-d-text2">{children}</h3>;
}

/**
 * About me, rendered from the safe markdown subset. `clamp` limits it to six
 * lines with a "Show more" that expands in place (or calls onMore).
 */
export function BioSection({ user, bio, clamp = false, onMore, plain = false }) {
  const ref = useRef(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);
  const text = bio ?? user?.bio;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !clamp) return;
    setOverflows(el.scrollHeight > el.clientHeight + 2);
  }, [text, clamp]);

  return (
    <section className={plain ? '' : 'mt-3 border-t border-d-divider pt-3'}>
      {!plain && <SectionTitle>{t('profile.aboutMe')}</SectionTitle>}
      {user?.profile_hidden ? (
        <p className="text-sm italic text-d-text3">{t('profile.hidden')}</p>
      ) : (
        <>
          <div ref={ref} className={`break-words text-sm leading-relaxed text-d-text ${clamp && !open ? 'line-clamp-6' : ''}`}>
            {text ? renderBio(text) : <span className="text-d-text3">{t('profile.noBio')}</span>}
          </div>
          {clamp && overflows && !open && (
            <button type="button" onClick={() => (onMore ? onMore() : setOpen(true))}
              className="mt-1 text-xs font-semibold text-d-link hover:underline">
              {t('profiles.showMore')}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function RolesSection({ roles = [], limit = null }) {
  const [all, setAll] = useState(false);
  const visible = roles.filter((r) => !r.name?.startsWith('@'));
  if (!visible.length) return null;
  const shown = limit && !all ? visible.slice(0, limit) : visible;
  const more = visible.length - shown.length;
  return (
    <section className="mt-3">
      <SectionTitle>{t('profile.roles', { count: visible.length })}</SectionTitle>
      <ul className="flex flex-wrap gap-1">
        {shown.map((role) => (
          <li key={role.id}
            className="flex items-center gap-1 rounded border border-d-divider bg-d-surface px-2 py-0.5 text-xs font-semibold text-d-text">
            <span className="h-2.5 w-2.5 rounded-full" aria-hidden="true"
              style={{ backgroundColor: role.color || 'var(--color-d-text4)' }} />
            {role.name}
          </li>
        ))}
        {more > 0 && (
          <li>
            <button type="button" onClick={() => setAll(true)}
              className="rounded border border-d-divider px-2 py-0.5 text-xs font-semibold text-d-text2 hover:text-d-strong">
              {t('profiles.moreRoles', { count: more })}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

const fmt = (iso) => new Date(iso).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short', year: 'numeric' });

export function SinceSection({ user, joinedAt }) {
  if (!user?.created_at && !joinedAt) return null;
  return (
    <section className="mt-3 grid grid-cols-2 gap-2 text-xs text-d-text2">
      {Boolean(user?.created_at) && (
        <div>
          <SectionTitle>{t('profile.discordSince')}</SectionTitle>
          <span className="text-sm text-d-text">{fmt(user.created_at)}</span>
        </div>
      )}
      {Boolean(joinedAt) && (
        <div>
          <SectionTitle>{t('profile.memberSince')}</SectionTitle>
          <span className="text-sm text-d-text">{fmt(joinedAt)}</span>
        </div>
      )}
    </section>
  );
}
