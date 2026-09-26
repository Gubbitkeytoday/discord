import React, { useState } from 'react';
import { avatarOf, defaultAvatar } from '../../utils/avatar';
import StatusIndicator, { statusLabel } from './StatusIndicator.jsx';

/**
 * One avatar component: fixed width/height (no layout shift), lazy + async
 * decoding, a coloured default when the user has no picture or the picture
 * fails, and an optional presence indicator cut into the corner.
 *
 *   <Avatar user={member} size={32} status={member.status} ring="var(--color-d-surface)" />
 *
 * The image is decorative by default (alt="") because the name is always
 * next to it; pass `alt` when it stands alone. With `status`, the indicator
 * is decorative unless `announceStatus` is set, so a row that says
 * "Mina, Do not disturb" is not read twice.
 */
export default function Avatar({
  user,
  src,
  size = 32,
  status,
  ring = 'var(--color-d-surface)',
  alt = '',
  announceStatus = false,
  eager = false,
  className = ''
}) {
  const [failed, setFailed] = useState(false);
  const fallback = defaultAvatar(user?.user_id ?? user?.userId ?? user?.id);
  const url = failed ? fallback : (src ?? (user ? avatarOf(user) : fallback));
  const dot = Math.max(10, Math.round(size * 0.3));

  return (
    <span className={`relative inline-block shrink-0 ${className}`} style={{ width: size, height: size }}>
      <img
        src={url}
        alt={alt}
        width={size}
        height={size}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        className="h-full w-full rounded-full object-cover bg-d-control2"
      />
      {status && (
        <StatusIndicator
          status={status}
          size={dot}
          ring={ring}
          decorative={!announceStatus}
          label={announceStatus ? statusLabel(status) : undefined}
          className="absolute -bottom-0.5 -right-0.5"
        />
      )}
    </span>
  );
}
