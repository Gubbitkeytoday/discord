import React, { useEffect, useState } from 'react';
import { Loader2, Users, Circle, AlertTriangle } from 'lucide-react';
import { get, post } from '../api';
import { t } from '../i18n/index.jsx';

/**
 * The screen behind /invite/:code — Discord shows the server, who invited you
 * and the member counts before you commit to joining.
 */
export default function InviteJoinScreen({ code, onJoined, onCancel }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    get(`/api/invites/${encodeURIComponent(code)}`)
      .then((data) => { if (!cancelled) setPreview(data); })
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

  return (
    <div className="fixed inset-0 bg-d-base flex items-center justify-center overlay-center p-4">
      <div className="w-full max-w-sm bg-d-canvas rounded-xl shadow-2xl border border-d-surface p-8 text-center">
        {!preview && !error && (
          <div className="flex flex-col items-center gap-3 text-d-text3">
            <Loader2 className="w-6 h-6 animate-spin" />
            <p className="text-sm">{t('invites.loading')}</p>
          </div>
        )}

        {error && (
          <div className="space-y-4">
            <AlertTriangle className="w-10 h-10 text-d-danger mx-auto" />
            <p className="text-sm text-d-danger">{error}</p>
            <button onClick={onCancel} className="text-sm text-d-link hover:underline">
              {t('invites.backToApp')}
            </button>
          </div>
        )}

        {preview && !error && (
          <>
            {preview.server.icon_url ? (
              <img
                src={preview.server.icon_url}
                alt=""
                className="w-20 h-20 rounded-2xl object-cover mx-auto mb-4"
              />
            ) : (
              <div className="w-20 h-20 rounded-2xl bg-d-surface flex items-center justify-center mx-auto mb-4 text-2xl font-bold text-d-strong">
                {preview.server.name.slice(0, 2).toUpperCase()}
              </div>
            )}

            <p className="text-xs text-d-text3 mb-1">
              {preview.inviter
                ? t('invites.invitedBy', { name: preview.inviter.display_name || preview.inviter.username })
                : t('invites.youWereInvited')}
            </p>
            <h1 className="text-xl font-bold text-d-strong mb-1">{preview.server.name}</h1>
            {preview.server.description && (
              <p className="text-xs text-d-text3 mb-3">{preview.server.description}</p>
            )}

            <div className="flex items-center justify-center gap-4 text-xs text-d-text3 mb-6">
              <span className="flex items-center gap-1.5">
                <Circle className="w-2 h-2 fill-d-online text-d-online" />
                {t('invites.onlineCount', { count: preview.server.online_count })}
              </span>
              <span className="flex items-center gap-1.5">
                <Users className="w-3 h-3" />
                {t('invites.memberCount', { count: preview.server.member_count })}
              </span>
            </div>

            <button
              onClick={join}
              disabled={busy}
              className="w-full bg-d-brand hover:bg-d-brandhover disabled:opacity-60 text-white font-semibold py-2.5 rounded transition-colors flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {preview.already_member ? t('invites.openServer') : t('invites.acceptInvite')}
            </button>
            <button onClick={onCancel} className="mt-3 text-xs text-d-text3 hover:underline">
              {t('invites.noThanks')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
