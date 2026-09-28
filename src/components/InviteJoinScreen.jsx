import React, { useEffect, useRef, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { get, post } from '../api';
import { t } from '../i18n/index.jsx';
import InviteSplash from './server/InviteSplash.jsx';
import ServerProfileCard from './server/ServerProfileCard.jsx';

// Written by LoginScreen when "Sign up & join" / "Log in & join" succeeds.
const AUTO_JOIN_KEY = 'antigravity.autoJoinInvite';

/**
 * The screen behind /invite/:code — Discord shows the server, who invited you
 * and the member counts before you commit to joining. The server's invite
 * splash (or a wash of its accent colour) fills the background, and the card
 * is the same server profile card Discover uses.
 */
export default function InviteJoinScreen({ code, onJoined, onCancel }) {
  const [preview, setPreview] = useState(null);
  // The public server profile (banner, accent, traits, splash); `false` when
  // it could not be loaded — the invite preview alone still works.
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    get(`/api/invites/${encodeURIComponent(code)}/profile`)
      .then((data) => { if (!cancelled) setProfile(data ?? false); })
      .catch(() => { if (!cancelled) setProfile(false); });
    get(`/api/invites/${encodeURIComponent(code)}`)
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        // "Sign up & join" on the login screen already said yes: accept at
        // once instead of asking a second time.
        let autoJoin = false;
        try {
          autoJoin = window.sessionStorage.getItem(AUTO_JOIN_KEY) === code;
          window.sessionStorage.removeItem(AUTO_JOIN_KEY);
        } catch { /* private window */ }
        if (autoJoin) joinRef.current?.();
      })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [code]);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const detail = await post(`/api/invites/${encodeURIComponent(code)}/accept`);
      onJoined(detail);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const joinRef = useRef(join);
  joinRef.current = join;

  const server = preview?.server ?? null;
  // The card: the profile when we have it, else what the invite preview says.
  const card = server ? {
    ...(profile || {}),
    id: profile?.id ?? server.id,
    name: profile?.name ?? server.name,
    description: profile?.description ?? server.description ?? null,
    icon_url: profile?.icon_url ?? server.icon_url ?? null,
    online_count: profile?.online_count ?? server.online_count ?? 0,
    member_count: profile?.member_count ?? server.member_count ?? 0,
    // The button below says "Open server" for members; never the "Joined" state.
    joined: false
  } : null;
  const actionLabel = busy
    ? t('safety.joining')
    : preview?.already_member ? t('invites.openServer') : t('invites.acceptInvite');

  return (
    <div className="fixed inset-0 overflow-y-auto overscroll-contain bg-d-base">
      <InviteSplash splashUrl={profile ? profile.splash_url : null} accentColor={profile ? profile.accent_color : null}>
        <div className="w-full max-w-sm">
          {!preview && !error && (
            <div role="status" className="flex flex-col items-center gap-3 rounded-xl bg-d-canvas p-8 text-d-text3 shadow-2xl">
              <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
              <p className="text-sm">{t('invites.loading')}</p>
            </div>
          )}

          {error && (
            <div role="alert" className="space-y-4 rounded-xl bg-d-canvas p-8 text-center shadow-2xl">
              <AlertTriangle className="w-10 h-10 text-d-danger mx-auto" aria-hidden="true" />
              <p className="text-sm text-d-dangertext">{error}</p>
              <button type="button" onClick={onCancel} className="min-h-10 text-sm text-d-link hover:underline">
                {t('invites.backToApp')}
              </button>
            </div>
          )}

          {card && !error && (
            <>
              <p className="mb-3 text-center text-sm font-medium text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]">
                {preview.inviter
                  ? t('invites.invitedBy', { name: preview.inviter.display_name || preview.inviter.username })
                  : t('invites.youWereInvited')}
              </p>
              <ServerProfileCard
                profile={card}
                headingLevel={1}
                actionLabel={actionLabel}
                busy={busy}
                onAction={join}
                className="shadow-2xl"
              />
              <button
                type="button"
                onClick={onCancel}
                className="mx-auto mt-3 block min-h-10 rounded px-3 text-sm font-medium text-white/90 hover:text-white hover:underline [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]"
              >
                {t('invites.noThanks')}
              </button>
            </>
          )}
        </div>
      </InviteSplash>
    </div>
  );
}
