import React, { useState } from 'react';
import { LogIn, UserPlus, AlertTriangle, Loader2, ArrowLeft } from 'lucide-react';
import { post, setApiIdentity } from '../api';
import { DEFAULT_AVATAR } from '../utils/avatar';
import { t } from '../i18n/index.jsx';

/**
 * Real login / registration against /api/auth. Shown when there is no session.
 * The seeded quick-sign-in column only appears when the server says the dev
 * identity shortcut is on, which it never is in production.
 */
export default function LoginScreen({ onAuthenticated, devAccounts = [], inviteCode }) {
  const [mode, setMode] = useState('login');   // login | register | forgot
  const [form, setForm] = useState({ username: '', password: '', display_name: '', email: '' });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'forgot') {
        await post('/api/auth/forgot-password', { email: form.email });
        setNotice(t('auth.resetSent'));
        return;
      }
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = mode === 'login'
        ? { username: form.username, password: form.password }
        : { username: form.username, password: form.password, display_name: form.display_name, email: form.email || undefined };
      const data = await post(endpoint, body);
      setApiIdentity({ userId: data.user.id, token: data.token });
      onAuthenticated(data.user, data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const quickLogin = async (account) => {
    setBusy(true);
    setError(null);
    try {
      const data = await post('/api/auth/login', {
        username: account.username, password: account.dev_password
      });
      setApiIdentity({ userId: data.user.id, token: data.token });
      onAuthenticated(data.user, data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-d-base flex items-center justify-center overlay-center p-4">
      <div className="w-full max-w-4xl bg-d-canvas rounded-xl shadow-2xl flex overflow-hidden">
        <form onSubmit={submit} className="flex-1 p-8 min-w-0">
          {mode === 'forgot' && (
            <button
              type="button"
              onClick={() => { setMode('login'); setError(null); setNotice(null); }}
              className="text-d-text3 hover:text-d-strong mb-3 flex items-center gap-1 text-xs"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> {t('common.back')}
            </button>
          )}

          <h1 className="text-2xl font-bold text-d-strong mb-1">
            {mode === 'login' ? t('auth.welcomeBack')
              : mode === 'register' ? t('auth.createAccount')
              : t('auth.forgotTitle')}
          </h1>
          <p className="text-sm text-d-text3 mb-6">
            {mode === 'login' ? t('auth.gladToSeeYou')
              : mode === 'register' ? t('auth.takesAMinute')
              : t('auth.forgotHint')}
          </p>

          {inviteCode && mode !== 'forgot' && (
            <div className="mb-4 px-3 py-2 bg-d-brand/10 border border-d-brand/40 rounded text-xs text-d-mention">
              {t('auth.signInToJoin')}
            </div>
          )}

          {error && (
            <div className="mb-4 px-3 py-2 bg-d-danger/10 border border-d-danger/40 rounded flex items-start gap-2 text-xs text-d-danger" role="alert">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <div className="mb-4 px-3 py-2 bg-d-online/10 border border-d-online/40 rounded text-xs text-d-online" role="status">
              {notice}
            </div>
          )}

          {mode === 'forgot' ? (
            <label className="block mb-6">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                {t('security.email')} <span className="text-d-danger">*</span>
              </span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                autoComplete="email"
                required
                className="w-full bg-d-base text-sm text-d-strong px-3 py-2.5 rounded border border-d-edge focus:outline-none focus:border-d-brand"
              />
            </label>
          ) : (
            <>
              <label className="block mb-4">
                <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                  {t('auth.username')} <span className="text-d-danger">*</span>
                </span>
                <input
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  autoComplete="username"
                  required
                  className="w-full bg-d-base text-sm text-d-strong px-3 py-2.5 rounded border border-d-edge focus:outline-none focus:border-d-brand"
                />
              </label>

              {mode === 'register' && (
                <>
                  <label className="block mb-4">
                    <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                      {t('auth.displayName')}
                    </span>
                    <input
                      value={form.display_name}
                      onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                      className="w-full bg-d-base text-sm text-d-strong px-3 py-2.5 rounded border border-d-edge focus:outline-none focus:border-d-brand"
                    />
                  </label>
                  <label className="block mb-4">
                    <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                      {t('security.email')}
                    </span>
                    <input
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      autoComplete="email"
                      className="w-full bg-d-base text-sm text-d-strong px-3 py-2.5 rounded border border-d-edge focus:outline-none focus:border-d-brand"
                    />
                    <span className="block text-[10px] text-d-text4 mt-1">{t('auth.emailHint')}</span>
                  </label>
                </>
              )}

              <label className="block mb-2">
                <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                  {t('auth.password')} <span className="text-d-danger">*</span>
                </span>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={mode === 'register' ? 8 : undefined}
                  className="w-full bg-d-base text-sm text-d-strong px-3 py-2.5 rounded border border-d-edge focus:outline-none focus:border-d-brand"
                />
                {mode === 'register' && (
                  <span className="block text-[10px] text-d-text4 mt-1">{t('auth.passwordHint')}</span>
                )}
              </label>

              {mode === 'login' && (
                <button
                  type="button"
                  onClick={() => { setMode('forgot'); setError(null); }}
                  className="text-[11px] text-d-link hover:underline mb-6 block"
                >
                  {t('auth.forgotPassword')}
                </button>
              )}
            </>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white font-semibold py-2.5 rounded transition-colors flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" />
              : mode === 'login' ? <LogIn className="w-4 h-4" />
              : mode === 'register' ? <UserPlus className="w-4 h-4" /> : null}
            {mode === 'login' ? t('auth.login') : mode === 'register' ? t('auth.register') : t('auth.sendResetLink')}
          </button>

          {mode !== 'forgot' && (
            <p className="text-xs text-d-text3 mt-3">
              {mode === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
              <button
                type="button"
                onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
                className="text-d-link hover:underline"
              >
                {mode === 'login' ? t('auth.register') : t('auth.login')}
              </button>
            </p>
          )}
        </form>

        {/* Seeded accounts, only offered while the dev identity shortcut is on. */}
        {devAccounts.length > 0 && (
          <div className="w-72 bg-d-surface p-6 shrink-0 hidden md:block">
            <h2 className="text-[11px] font-bold text-d-text2 uppercase mb-1">{t('auth.devAccounts')}</h2>
            <p className="text-[11px] text-d-text4 mb-4">{t('auth.devAccountsHint')}</p>
            <div className="space-y-1">
              {devAccounts.map((account) => (
                <button
                  key={account.id}
                  onClick={() => quickLogin(account)}
                  disabled={busy}
                  className="w-full flex items-center gap-2 p-2 rounded hover:bg-d-hover text-left transition-colors disabled:opacity-50"
                >
                  <img src={account.avatar_url || DEFAULT_AVATAR} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm text-d-strong truncate">{account.display_name}</span>
                    <span className="block text-[11px] text-d-text3 truncate">@{account.username}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
