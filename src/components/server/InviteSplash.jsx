import React from 'react';
import { proxiedImageUrl } from '../../utils/media';
import './server.css';

/**
 * The invite page's full-bleed background: the server's splash image under a
 * dark gradient (so the card and any text over it stay readable), or — with
 * no splash — a soft wash of the server's accent colour. `children` is the
 * invite card, centred; the splash itself is decorative.
 *
 *   <InviteSplash splashUrl={profile.splash_url} accentColor={profile.accent_color}>
 *     <ServerProfileCard profile={profile} actionLabel="Accept invite" onAction={accept} />
 *   </InviteSplash>
 */
export default function InviteSplash({ splashUrl, accentColor = null, children, className = '' }) {
  const src = splashUrl ? proxiedImageUrl(splashUrl) : null;
  const wash = accentColor && /^#[0-9a-f]{6}$/i.test(accentColor) ? accentColor : 'var(--color-d-brand)';
  return (
    <div className={`relative min-h-dvh w-full overflow-hidden bg-d-base3 ${className}`}>
      {src ? (
        <img src={src} alt="" aria-hidden="true" className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div
          aria-hidden="true"
          data-custom-color
          className="absolute inset-0"
          style={{ background: `radial-gradient(circle at 20% 10%, color-mix(in srgb, ${wash} 45%, transparent), transparent 60%), radial-gradient(circle at 85% 90%, color-mix(in srgb, ${wash} 30%, transparent), transparent 55%)` }}
        />
      )}
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/45 to-black/25" />
      <div className="relative z-[1] min-h-dvh flex items-center justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>
  );
}
