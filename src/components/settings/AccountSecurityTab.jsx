import React, { useCallback, useEffect, useState } from 'react';
import {
  ShieldCheck, ShieldOff, KeyRound, Mail, Monitor, Loader2, Check, Copy, LogOut, AlertTriangle
} from 'lucide-react';
import { get, post, del } from '../../api';
import { localeTag, t } from '../../i18n/index.jsx';
import { useUserSettings } from '../../hooks/useUserSettings';
import { PageHeader, Divider } from './primitives';

/**
 * Account and security: password, two-factor with recovery codes, e-mail
 * verification and the list of signed-in devices. Every control here talks to
 * a real endpoint — nothing is display-only.
 */
export default function AccountSecurityTab({ currentUser, onToast, onSignOut }) {
  // Streamer Mode hides personal information; the class blurs it until hovered.
  const { prefs } = useUserSettings();
  const sensitive = prefs.streamerMode.enabled && prefs.streamerMode.hidePersonalInformation
    ? 'streamer-sensitive'
    : '';
  const [mfa, setMfa] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [enrolment, setEnrolment] = useState(null);   // { secret, otpauth_uri }
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /**
   * Fetch the export and hand it to the browser as a file. Done with fetch
   * rather than a plain link because the endpoint needs the session header.
   */
  const downloadExport = async () => {
    setBusy('export');
    try {
      const data = await get('/api/users/@me/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'antigravity-export.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally { setBusy(null); }
  };

  /** Deleting is permanent, so the first click only arms the second. */
  const removeAccount = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy('delete');
    try {
      await del('/api/users/@me');
      window.location.reload();
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
      setConfirmDelete(false);
    } finally { setBusy(null); }
  };
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [passwordDone, setPasswordDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const [status, list] = await Promise.all([
        get('/api/auth/mfa/status').catch(() => null),
        get('/api/auth/sessions').catch(() => [])
      ]);
      setMfa(status);
      setSessions(Array.isArray(list) ? list : []);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    }
  }, [onToast]);

  useEffect(() => { load(); }, [load]);

  const run = async (key, fn) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const beginMfa = () => run('mfa', async () => {
    setEnrolment(await post('/api/auth/mfa/begin'));
    setRecoveryCodes(null);
  });

  const confirmMfa = (e) => {
    e.preventDefault();
    return run('mfa', async () => {
      const result = await post('/api/auth/mfa/confirm', { code: code.trim() });
      setRecoveryCodes(result.recovery_codes ?? null);
      setEnrolment(null);
      setCode('');
      await load();
      onToast?.(t('security.mfaEnabled'), { type: 'success' });
    });
  };

  const disableMfa = (e) => {
    e.preventDefault();
    return run('mfa', async () => {
      await post('/api/auth/mfa/disable', { code: code.trim() });
      setCode('');
      setRecoveryCodes(null);
      await load();
      onToast?.(t('security.mfaDisabled'), { type: 'success' });
    });
  };

  // Changing a password revokes every other session; if the server also drops
  // ours (no session cookie survives), the honest response is the login screen.
  const changePassword = (e) => {
    e.preventDefault();
    if (passwords.next !== passwords.confirm) {
      onToast?.(t('security.passwordMismatch'), { type: 'error' });
      return undefined;
    }
    return run('password', async () => {
      await post('/api/auth/change-password', {
        current_password: passwords.current, new_password: passwords.next
      });
      setPasswords({ current: '', next: '', confirm: '' });
      setPasswordDone(true);
      setTimeout(() => setPasswordDone(false), 3000);
      await load();
      onToast?.(t('security.passwordChanged'), { type: 'success' });
    });
  };

  const verifyEmail = () => run('email', async () => {
    await post('/api/auth/verify-email/request');
    onToast?.(t('security.verificationSent'), { type: 'success' });
  });

  const revokeSession = (id) => run(`session-${id}`, async () => {
    const wasCurrent = sessions.find((s) => s.id === id)?.current;
    await del(`/api/auth/sessions/${id}`);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    // Revoking the session you are using leaves the tab holding a dead cookie.
    if (wasCurrent) onSignOut?.();
  });

  const revokeAll = () => run('logout-all', async () => {
    await post('/api/auth/logout-all');
    await load();
    onToast?.(t('security.otherDevicesSignedOut'), { type: 'success' });
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t('settings.accountTitle')} description={t('settings.accountLead')} />

      {/* Identity */}
      <section className="space-y-2 rounded-lg border border-d-divider bg-d-surface p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-d-text2 uppercase">{t('auth.username')}</p>
            <p className={`text-sm text-d-strong truncate ${sensitive}`}>
              {currentUser?.username}{currentUser?.discriminator ? `#${currentUser.discriminator}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 pt-2 border-t border-d-divider">
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-d-text2 uppercase">{t('security.email')}</p>
            <p className={`text-sm text-d-strong truncate ${sensitive}`}>
              {currentUser?.email || t('security.noEmail')}
            </p>
          </div>
          {currentUser?.email && (
            <button
              onClick={verifyEmail}
              disabled={busy === 'email'}
              className="text-xs bg-d-surface hover:bg-d-hover text-d-strong px-3 py-2 rounded flex items-center gap-2 transition-colors"
            >
              {busy === 'email' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
              {t('security.verifyEmail')}
            </button>
          )}
        </div>
      </section>

      <Divider />

      {/* Password */}
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.02em] text-d-text2">
          <KeyRound className="w-4 h-4" /> {t('security.password')}
        </h3>
        <form onSubmit={changePassword} className="space-y-3 bg-d-base rounded-xl border border-d-divider p-4">
          <label className="block">
            <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('security.currentPassword')}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={passwords.current}
              onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
              className="w-full bg-d-surface text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('security.newPassword')}</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={passwords.next}
                onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
                className="w-full bg-d-surface text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('security.confirmPassword')}</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={passwords.confirm}
                onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
                className="w-full bg-d-surface text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
              />
            </label>
          </div>
          <p className="text-[11px] text-d-text3">{t('security.passwordPolicy')}</p>
          <button
            type="submit"
            disabled={busy === 'password' || !passwords.next}
            className="bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded flex items-center gap-2 transition-colors"
          >
            {busy === 'password' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : passwordDone ? <Check className="w-3.5 h-3.5" /> : null}
            {t('security.changePassword')}
          </button>
        </form>
      </section>

      <Divider />

      {/* Two-factor */}
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.02em] text-d-text2">
          {mfa?.enabled ? <ShieldCheck className="w-4 h-4 text-d-online" /> : <ShieldOff className="w-4 h-4" />}
          {t('security.twoFactor')}
        </h3>

        <div className="bg-d-base rounded-xl border border-d-divider p-4 space-y-3">
          <p className="text-xs text-d-text2">
            {mfa?.enabled
              ? t('security.mfaOn', { count: mfa.recovery_codes_remaining ?? 0 })
              : t('security.mfaOff')}
          </p>

          {!mfa?.enabled && !enrolment && (
            <button
              onClick={beginMfa}
              disabled={busy === 'mfa'}
              className="bg-d-success hover:bg-d-successhover text-white text-xs font-semibold px-4 py-2 rounded flex items-center gap-2 transition-colors"
            >
              {busy === 'mfa' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
              {t('security.enableMfa')}
            </button>
          )}

          {enrolment && (
            <form onSubmit={confirmMfa} className="space-y-3">
              <p className="text-xs text-d-text2">{t('security.scanHint')}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-d-surface text-xs text-d-strong px-3 py-2 rounded break-all font-mono">
                  {enrolment.secret}
                </code>
                <button
                  type="button"
                  onClick={() => { navigator.clipboard?.writeText(enrolment.secret); onToast?.(t('common.copied'), { type: 'success', ttl: 2000 }); }}
                  className="p-2 bg-d-surface hover:bg-d-hover rounded text-d-text2"
                  aria-label={t('common.copy')}
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
              {enrolment.otpauth_uri && (
                <p className="text-[11px] text-d-text4 break-all">{enrolment.otpauth_uri}</p>
              )}
              <label className="block">
                <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('security.sixDigitCode')}</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="w-40 bg-d-surface text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand tracking-[0.3em] font-mono"
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={code.length !== 6 || busy === 'mfa'}
                  className="bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded"
                >
                  {t('security.confirm')}
                </button>
                <button type="button" onClick={() => setEnrolment(null)} className="text-xs text-d-text3 hover:underline">
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          )}

          {recoveryCodes && (
            <div className="bg-d-surface rounded p-3 space-y-2">
              <p className="text-xs text-d-strong font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-d-idle" /> {t('security.saveRecoveryCodes')}
              </p>
              <div className="grid grid-cols-2 gap-1 font-mono text-xs text-d-text">
                {recoveryCodes.map((c) => <span key={c}>{c}</span>)}
              </div>
              <button
                onClick={() => { navigator.clipboard?.writeText(recoveryCodes.join('\n')); onToast?.(t('common.copied'), { type: 'success', ttl: 2000 }); }}
                className="text-[11px] text-d-link hover:underline"
              >
                {t('common.copy')}
              </button>
            </div>
          )}

          {mfa?.enabled && (
            <form onSubmit={disableMfa} className="flex items-end gap-2 pt-2 border-t border-d-divider">
              <label className="block">
                <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('security.sixDigitCode')}</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  className="w-36 bg-d-surface text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand tracking-[0.3em] font-mono"
                />
              </label>
              <button
                type="submit"
                disabled={code.length !== 6 || busy === 'mfa'}
                className="bg-d-danger hover:bg-red-600 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded"
              >
                {t('security.disableMfa')}
              </button>
            </form>
          )}
        </div>
      </section>

      <Divider />

      {/* Devices */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.02em] text-d-text2">
            <Monitor className="w-4 h-4" /> {t('security.devices')}
          </h3>
          {sessions.length > 1 && (
            <button
              onClick={revokeAll}
              disabled={busy === 'logout-all'}
              className="text-xs text-d-danger hover:underline flex items-center gap-1"
            >
              <LogOut className="w-3.5 h-3.5" /> {t('security.signOutOthers')}
            </button>
          )}
        </div>

        <div className="bg-d-base rounded-xl border border-d-divider divide-y divide-d-divider">
          {sessions.length === 0 && <p className="p-4 text-xs text-d-text4">{t('security.noSessions')}</p>}
          {sessions.map((session) => (
            <div key={session.id} className="p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-d-strong truncate">
                  {session.device_name || session.user_agent || t('security.unknownDevice')}
                  {session.current && (
                    <span className="ml-2 text-[10px] bg-d-online/20 text-d-online px-1.5 py-0.5 rounded">
                      {t('security.thisDevice')}
                    </span>
                  )}
                </p>
                <p className={`text-[11px] text-d-text3 truncate ${sensitive}`}>
                  {session.ip_address ?? '—'} · {new Date(session.last_seen_at ?? session.created_at).toLocaleString(localeTag())}
                </p>
              </div>
              {!session.current && (
                <button
                  onClick={() => revokeSession(session.id)}
                  disabled={busy === `session-${session.id}`}
                  className="text-xs text-d-danger hover:underline shrink-0"
                >
                  {t('security.revoke')}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <Divider />

      {/* Your data. An export is a plain JSON file of what this account made;
          deletion is permanent and is deliberately two clicks away. */}
      <section>
        <h3 className="text-xs font-bold uppercase tracking-wide text-d-text3 mb-2">
          {t('security.yourData')}
        </h3>
        <p className="text-sm text-d-text3 mb-3">{t('security.exportHint')}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={downloadExport}
            disabled={busy === 'export'}
            className="px-3 py-2 rounded-md bg-d-surface hover:bg-d-surface/70 text-sm font-semibold text-d-strong"
          >
            {busy === 'export' ? t('common.loading') : t('security.requestExport')}
          </button>
          <button
            type="button"
            onClick={removeAccount}
            disabled={busy === 'delete'}
            className="px-3 py-2 rounded-md bg-d-danger/90 hover:bg-d-danger text-sm font-semibold text-white"
          >
            {confirmDelete ? t('security.deleteConfirm') : t('security.deleteAccount')}
          </button>
        </div>
        {confirmDelete && (
          <p className="mt-2 text-xs text-d-danger">{t('security.deleteWarning')}</p>
        )}
      </section>
    </div>
  );
}
