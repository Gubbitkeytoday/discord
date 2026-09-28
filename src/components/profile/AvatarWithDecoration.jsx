import React, { useState } from 'react';
import StillImage, { isAnimatedImage } from '../StillImage';
import StatusIndicator from '../ui/StatusIndicator.jsx';
import CosmeticImage from './CosmeticImage';
import { useMotionAllowed, useViewerPrefs } from '../../profile/motion';
import { proxiedImageUrl } from '../../utils/media';
import { DEFAULT_AVATAR, defaultAvatar } from '../../utils/avatar';
import '../../profile/profile.css';

/**
 * An avatar with its decoration drawn around it at 1.2× the avatar size.
 *
 * Stable API (used by member list, chat, popouts, the profile editor):
 *   src          avatar URL (falls back to the default avatar for `userId`)
 *   size         avatar diameter in px
 *   decoration   a catalogue item (identity.decoration) or null
 *   context      'list'  — static; animates while hovered/focused (default)
 *                'profile' — animates (subject to motion + viewer settings)
 *   status       presence to draw as a dot (optional); `ring` its cut-out colour
 *   animated     the avatar file is animated (GIF / animated WebP); inferred
 *                from the URL when omitted. Static until hover in lists and
 *                whenever motion is reduced.
 *   hovered      let a parent row drive hover (e.g. the whole member row)
 */
export default function AvatarWithDecoration(props) {
  const isAnimated = props.animated ?? isAnimatedImage({ url: props.src ?? '' });
  // Most avatars in a long chat have nothing to animate: those skip the
  // hover state and motion / viewer subscriptions entirely.
  if (!props.decoration && !isAnimated) return <PlainAvatar {...props} />;
  return <DecoratedAvatar {...props} isAnimated={isAnimated} />;
}

function PlainAvatar({
  src, userId = null, size = 40, status = null, ring = 'var(--color-d-panel)', alt = '', className = '', imgClassName = ''
}) {
  const url = proxiedImageUrl(src || (userId ? defaultAvatar(userId) : DEFAULT_AVATAR));
  const dot = Math.min(24, Math.max(10, Math.round(size * 0.24)));
  return (
    <span className={`relative inline-block shrink-0 ${className}`} style={{ width: size, height: size }}>
      <img src={url} alt={alt} className={`h-full w-full rounded-full object-cover ${imgClassName}`}
        loading="lazy" decoding="async" />
      {status && (
        <span className="absolute" style={{ right: -2, bottom: -2 }}>
          <StatusIndicator status={status} size={dot} ring={ring} />
        </span>
      )}
    </span>
  );
}

function DecoratedAvatar({
  src, userId = null, size = 40, decoration = null, context = 'list', status = null,
  ring = 'var(--color-d-panel)', isAnimated, hovered, alt = '', className = '', imgClassName = ''
}) {
  const [hoverSelf, setHoverSelf] = useState(false);
  const hover = hovered ?? hoverSelf;
  const motion = useMotionAllowed();
  const viewer = useViewerPrefs();
  const url = proxiedImageUrl(src || (userId ? defaultAvatar(userId) : DEFAULT_AVATAR));
  const playAvatar = motion && (context === 'profile' || hover);
  const showDeco = decoration && viewer.decorations !== 'off';
  const animateDeco = viewer.decorations === 'animate'
    ? (context === 'profile' || hover)
    : hover;
  const dot = Math.min(24, Math.max(10, Math.round(size * 0.24)));

  return (
    <span
      className={`relative inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
      onMouseEnter={() => setHoverSelf(true)}
      onMouseLeave={() => setHoverSelf(false)}
      onFocus={() => setHoverSelf(true)}
      onBlur={() => setHoverSelf(false)}
    >
      {isAnimated ? (
        <StillImage src={url} alt={alt} animate={playAvatar} playOnHover
          className={`h-full w-full rounded-full object-cover ${imgClassName}`} />
      ) : (
        <img src={url} alt={alt} className={`h-full w-full rounded-full object-cover ${imgClassName}`}
          loading="lazy" decoding="async" />
      )}
      {showDeco && (
        <CosmeticImage
          item={decoration}
          animate={animateDeco}
          className="pointer-events-none absolute max-w-none select-none"
          style={{ width: size * 1.2, height: size * 1.2, left: -size * 0.1, top: -size * 0.1 }}
        />
      )}
      {status && (
        <span className="absolute" style={{ right: -2, bottom: -2 }}>
          <StatusIndicator status={status} size={dot} ring={ring} />
        </span>
      )}
    </span>
  );
}
