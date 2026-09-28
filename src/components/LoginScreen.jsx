import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LogIn, UserPlus, AlertTriangle, Loader2, ArrowLeft, ShieldCheck, Fingerprint, Users, Circle } from 'lucide-react';
import { get, post, setApiIdentity } from '../api';
import { serverIconOf } from '../utils/avatar';
import BirthdateFields, { ageFromFields } from './admin/BirthdateFields';
import { takeSignedOutMarker, retryMinutes } from './admin/safety';
import { DEFAULT_AVATAR } from '../utils/avatar';
import { t } from '../i18n/index.jsx';
import { LanguageMenu } from '../i18n/LanguagePicker.jsx';
import { proxiedImageUrl } from '../utils/media';
import {
  passkeysAvailable, conditionalUiAvailable, signInWithPasskey, cancelPasskeyCeremony
} from '../auth/passkeys';

/**
 * Real login / registration against /api/auth. Shown when there is no session.
 * The seeded quick-sign-in column only appears when the server says the dev
 * identity shortcut is on, which it never is in production.
 */
// Set once this browser has signed in, so "Welcome back!" greets only people
// who have actually been here before.
const RETURNING_KEY = 'antigravity.hasSignedIn';
// Read by InviteJoinScreen: accept this invite as soon as the session exists,
// so "Sign up & join" is one step, not two.
export const AUTO_JOIN_KEY = 'antigravity.autoJoinInvite';

function isReturning() {
  try { return window.localStorage.getItem(RETURNING_KEY) === '1'; } catch { return false; }
}

/**
 * After a 2xx from login/register the session cookie must actually have
 * stuck. A Secure cookie over plain http (a LAN test of a production build)
 * is silently dropped by the browser, which used to look like "it let me in,
 * then forgot me". Asked with the cookie alone — no bearer, no dev header.
 */
async function cookieStuck() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    return res.status !== 401;
  } catch {
    return true;   // offline: nothing to conclude
  }
}

export default function LoginScreen({ onAuthenticated, devAccounts = [], inviteCode, initialNotice = null }) {
  // An invite link is almost always someone new: start on sign-up.
  const [mode, setMode] = useState(() => (inviteCode ? 'register' : 'login'));   // login | register | forgot | mfa
  const [form, setForm] = useState({ username: '', password: '', display_name: '', email: '', mfa_code: '' });
  const [birth, setBirth] = useState({ day: '', month: '', year: '' });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(() => {
    // A revoked / expired session was dropped server-side; say why the user
    // is looking at a login form.
    const signedOut = takeSignedOutMarker();
    return initialNotice ?? (signedOut ? t('safety.signedOutNotice') : null);
  });
  const [invite, setInvite] = useState(null);          // public invite preview
  const [inviteError, setInviteError] = useState(null);
  const [registration, setRegistration] = useState(null);   // { mode, invite_required, ... }
  const [returning] = useState(isReturning);
  const firstFieldRef = useRef(null);
  const headingRef = useRef(null);
  const modeChanged = useRef(false);
  const [busy, setBusy] = useState(false);
  const [passkeys, setPasskeys] = useState(false);   // server + browser support
  const mounted = useRef(true);
  // Bumped after a failed attempt so the autofill ceremony (cancelled by the
  // attempt) is offered again.
  const [autofillRound, setAutofillRound] = useState(0);

  /** Every successful sign-in ends here. */
  const finish = useCallback((data) => {
    try { window.localStorage.setItem(RETURNING_KEY, '1'); } catch { /* private window */ }
    if (inviteCode) {
      try { window.sessionStorage.setItem(AUTO_JOIN_KEY, inviteCode); } catch { /* private window */ }
    }
    setApiIdentity({ userId: data.user.id, token: data.token });
    onAuthenticated(data.user, data.token);
  }, [onAuthenticated, inviteCode]);

  /** Both the button and the autofill end here with { user, token }. */
  const finishPasskey = useCallback((data) => {
    if (!data?.user?.id) throw Object.assign(new Error(t('apiError.generic', { code: 'NO_SESSION' })), { code: 'NO_SESSION' });
    finish(data);
  }, [finish]);

  // What sign-up allows here (open / invite-only / closed), and the invite.
  useEffect(() => {
    let live = true;
    get('/api/auth/registration').then((r) => { if (live) setRegistration(r); }).catch(() => {});
    if (inviteCode) {
      get(`/api/invites/${encodeURIComponent(inviteCode)}`)
        .then((p) => { if (live) setInvite(p); })
        .catch((err) => { if (live) setInviteError(err.message); });
    }
    return () => { live = false; };
  }, [inviteCode]);

  // Moving between log in / sign up / reset: put focus on the first field of
  // the new form (a screen reader otherwise stays on a button that vanished).
  useEffect(() => {
    if (!modeChanged.current) { modeChanged.current = true; return; }
    (firstFieldRef.current ?? headingRef.current)?.focus();
  }, [mode]);

  const switchMode = (next) => { setMode(next); setError(null); setNotice(null); };

  useEffect(() => {
    mounted.current = true;
    passkeysAvailable().then((ok) => { if (mounted.current) setPasskeys(ok); }).catch(() => {});
    return () => { mounted.current = false; cancelPasskeyCeremony(); };
  }, []);

  // Conditional UI: offer saved passkeys in the username field's autofill
  // while the sign-in form is showing. The ceremony waits until the user
  // picks one (or it is cancelled when the form is submitted / left).
  useEffect(() => {
    if (mode !== 'login') return undefined;
    let cancelled = false;
    (async () => {
      if (!(await conditionalUiAvailable()) || cancelled) return;
      try {
        const data = await signInWithPasskey({ conditional: true });
        if (!cancelled && mounted.current) finishPasskey(data);
      } catch {
        // Autofill is passive: a failed or superseded background ceremony
        // must not replace the error from a password attempt the user just
        // made. The explicit "Sign in with a passkey" button reports errors.
      }
    })();
    return () => { cancelled = true; cancelPasskeyCeremony(); };
  }, [mode, finishPasskey, autofillRound]);

  const passkeyLogin = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // The modal request replaces a pending autofill one.
      await cancelPasskeyCeremony();
      finishPasskey(await signInWithPasskey());
    } catch (err) {
      if (!err?.cancelled) setError(err?.message ?? String(err));
      if (mounted.current) setAutofillRound((n) => n + 1);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (mode === 'login') cancelPasskeyCeremony();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'forgot') {
        await post('/api/auth/forgot-password', { email: form.email });
        setNotice(t('auth.resetSent'));
        return;
      }
      const isLogin = mode === 'login' || mode === 'mfa';
      const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
      let birthDate;
      if (!isLogin) {
        const age = ageFromFields(birth);
        if (age != null && age < 13) { setError(t('safety.tooYoung')); return; }
        if (age == null && registration?.birthdate_required) { setError(t('safety.dobIncomplete')); return; }
        if (age != null) birthDate = { year: Number(birth.year), month: Number(birth.month), day: Number(birth.day) };
      }
      const body = isLogin
        ? { username: form.username, password: form.password, ...(mode === 'mfa' ? { mfa_code: form.mfa_code.replace(/\s+/g, '') } : {}) }
        : {
            username: form.username, password: form.password, display_name: form.display_name,
            email: form.email || undefined, birth_date: birthDate, invite_code: inviteCode || undefined
          };
      const data = await post(endpoint, body);
      // Registration can answer with a generic, success-shaped body (no
      // session) so it does not reveal whether an e-mail is already in use.
      // Treat that as "look in your inbox", not as a crash.
      if (!data?.user?.id) {
        setNotice(isLogin ? t('apiError.generic', { code: 'NO_SESSION' }) : t('auth.checkEmail'));
        if (!isLogin) setMode('login');
        return;
      }
      if (!(await cookieStuck())) {
        setError(t('safety.cookieRefused'));
        return;
      }
      finish(data);
    } catch (err) {
      // A 2FA account: the password was right, now ask for the second factor
      // and resend the same credentials with it.
      if (err.code === 'MFA_REQUIRED') {
        setMode('mfa');
        setForm((f) => ({ ...f, mfa_code: '' }));
        return;
      }
      const minutes = retryMinutes(err);
      if (err.code === 'REGISTER_RATE_LIMITED') setError(t('safety.registerRateLimited', { minutes: minutes ?? 1 }));
      else if (err.status === 429 && minutes) setError(t('safety.rateLimitedWait', { minutes }));
      else if (err.code === 'AGE_TOO_YOUNG') setError(t('safety.tooYoung'));
      else setError(err.message);
      if (mode === 'login') setAutofillRound((n) => n + 1);
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
      finish(data);
    } catch (err) {
      if (err.code === 'MFA_REQUIRED') {
        setForm((f) => ({ ...f, username: account.username, password: account.dev_password, mfa_code: '' }));
        setMode('mfa');
        return;
      }
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-d-base flex items-center justify-center overlay-center p-4 max-sm:pt-16">
      <LanguageMenu className="absolute top-3 right-3" />
      {/* Discord's auth card is a narrow ~480px column; the old 896px card
          stretched two inputs across the whole screen whenever the dev-account
          column was not there to fill it. */}
      <div className={`w-full ${devAccounts.length > 0 ? 'max-w-3xl' : 'max-w-[30rem]'} bg-d-canvas rounded-xl shadow-2xl flex overflow-hidden`}>
        <form onSubmit={submit} className="flex-1 p-8 max-sm:p-6 min-w-0">
          {(mode === 'forgot' || mode === 'mfa') && (
            <button
              type="button"
              onClick={() => switchMode('login')}
              className="text-d-text3 hover:text-d-strong mb-3 flex items-center gap-1 text-xs"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> {t('common.back')}
            </button>
          )}

          {inviteCode && invite && mode !== 'forgot' && (
            <InviteHeader invite={invite} />
          )}

          <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-d-strong mb-1 text-center focus:outline-none">
            {mode === 'login' ? (invite ? t('safety.loginToJoin') : returning ? t('auth.welcomeBack') : t('safety.loginTitle'))
              : mode === 'register' ? (invite ? t('safety.createToJoin') : t('auth.createAccount'))
              : mode === 'mfa' ? t('auth.mfaTitle')
              : t('auth.forgotTitle')}
          </h1>
          <p className="text-sm text-d-text3 mb-6 text-center">
            {mode === 'login' ? (returning ? t('auth.gladToSeeYou') : t('safety.loginLead'))
              : mode === 'register' ? t('auth.takesAMinute')
              : mode === 'mfa' ? t('auth.mfaHint')
              : t('auth.forgotHint')}
          </p>

          {inviteCode && inviteError && mode !== 'forgot' && (
            <div className="mb-4 px-3 py-2 bg-d-idle/10 border border-d-idle/40 rounded text-xs text-d-text" role="status">
              {t('safety.inviteInvalid')}
            </div>
          )}
          {mode === 'register' && registration?.mode === 'closed' && (
            <div className="mb-4 px-3 py-2 bg-d-idle/10 border border-d-idle/40 rounded text-xs text-d-text" role="status">
              {t('safety.registrationClosed')}
            </div>
          )}
          {mode === 'register' && registration?.invite_required && !invite && (
            <div className="mb-4 px-3 py-2 bg-d-idle/10 border border-d-idle/40 rounded text-xs text-d-text" role="status">
              {t('safety.registrationInviteOnly')}
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

          {mode === 'mfa' ? (
            <label className="block mb-6">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                {t('auth.mfaCode')} <span className="text-d-danger">*</span>
              </span>
              <input
                value={form.mfa_code}
                onChange={(e) => setForm({ ...form, mfa_code: e.target.value })}
                autoComplete="one-time-code"
                inputMode="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={32}
                autoFocus
                ref={firstFieldRef}
                required
                placeholder="123456"
                className="w-full bg-d-base text-lg tracking-[0.3em] text-center font-mono text-d-strong px-3 py-2.5 rounded border border-d-edge focus:outline-none focus:border-d-brand placeholder-d-text4"
              />
            </label>
          ) : mode === 'forgot' ? (
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
                ref={firstFieldRef}
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
                  autoComplete={mode === 'login' && passkeys ? 'username webauthn' : 'username'}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                  ref={firstFieldRef}
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
                  <div className="mb-4">
                    <BirthdateFields value={birth} onChange={setBirth} required={Boolean(registration?.birthdate_required)} />
                  </div>
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
                  onClick={() => switchMode('forgot')}
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
              : mode === 'register' ? <UserPlus className="w-4 h-4" />
              : mode === 'mfa' ? <ShieldCheck className="w-4 h-4" /> : null}
            {mode === 'login' ? (invite ? t('safety.loginAndJoin') : t('auth.login'))
              : mode === 'register' ? (invite ? t('safety.signUpAndJoin') : t('auth.register'))
              : mode === 'mfa' ? t('auth.mfaVerify')
              : t('auth.sendResetLink')}
          </button>

          {mode === 'login' && passkeys && (
            <>
              <div className="flex items-center gap-3 my-3 text-[11px] uppercase text-d-text4" aria-hidden="true">
                <span className="flex-1 h-px bg-d-edge" />
                {t('passkeys.or')}
                <span className="flex-1 h-px bg-d-edge" />
              </div>
              <button
                type="button"
                onClick={passkeyLogin}
                disabled={busy}
                data-testid="passkey-login"
                className="w-full bg-d-surface hover:bg-d-hover disabled:opacity-50 text-d-strong font-semibold py-2.5 rounded border border-d-edge transition-colors flex items-center justify-center gap-2"
              >
                <Fingerprint className="w-4 h-4" />
                {t('passkeys.signIn')}
              </button>
            </>
          )}

          {(mode === 'register' || (mode === 'login' && registration?.mode !== 'closed')) && (
            <p className="text-xs text-d-text3 mt-3">
              {mode === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
              <button
                type="button"
                onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
                className="text-d-link hover:underline min-h-6"
              >
                {mode === 'login' ? t('auth.register') : t('auth.login')}
              </button>
            </p>
          )}
          {mode === 'register' && (
            <p className="text-[11px] text-d-text3 mt-3 leading-relaxed">{t('safety.signupTerms')}</p>
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
                  <img src={proxiedImageUrl(account.avatar_url || DEFAULT_AVATAR)} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
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

/** "Nok invited you to join ม.2/5 Roblox" with the icon and counts, above the form. */
function InviteHeader({ invite }) {
  const icon = serverIconOf(invite.server);
  const inviter = invite.inviter?.display_name || invite.inviter?.username;
  return (
    <div className="mb-5 flex flex-col items-center text-center">
      {icon ? (
        <img src={icon} alt="" className="mb-2 h-16 w-16 rounded-2xl object-cover" />
      ) : (
        <div className="mb-2 flex h-16 w-16 items-center justify-center rounded-2xl bg-d-surface text-xl font-bold text-d-strong" aria-hidden="true">
          {invite.server.name.slice(0, 2).toUpperCase()}
        </div>
      )}
      <p className="text-xs text-d-text3">
        {inviter ? t('invites.invitedBy', { name: inviter }) : t('invites.youWereInvited')}
      </p>
      <p className="text-lg font-bold text-d-strong break-words [overflow-wrap:anywhere]">{invite.server.name}</p>
      <p className="mt-1 flex items-center justify-center gap-3 text-xs text-d-text3">
        <span className="flex items-center gap-1.5">
          <Circle className="h-2 w-2 fill-d-online text-d-online" aria-hidden="true" />
          {t('invites.onlineCount', { count: invite.server.online_count ?? 0 })}
        </span>
        <span className="flex items-center gap-1.5">
          <Users className="h-3 w-3" aria-hidden="true" />
          {t('invites.memberCount', { count: invite.server.member_count ?? 0 })}
        </span>
      </p>
    </div>
  );
}
