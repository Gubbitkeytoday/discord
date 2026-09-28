import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, post } from '../api';
import {
  MessageSquare, UserPlus, UserMinus, ShieldAlert, ShieldOff, Pencil, Check, MoreHorizontal, Flag, Eraser
} from 'lucide-react';
import { useEscapeLayer } from './settings/primitives';
import ReportDialog from './admin/ReportDialog';
import ConfirmModal from './ConfirmModal';
import { useStreamerMask } from './admin/safety';
import { t } from '../i18n/index.jsx';
import ProfilePopout from './profile/ProfilePopout';
import ProfileFullModal from './profile/ProfileFullModal';
import { useIdentity, primeIdentity } from '../profile/store';
import { fetchProfile, resetMemberProfile } from '../profile/api';
import { recentAnchorRect } from '../profile/anchor';

/**
 * A person's profile: a compact popout beside whatever opened it, or the full
 * profile (tabs: About, Mutual servers, Mutual friends, Note).
 *
 * Props (unchanged from the single-modal version, plus):
 *   variant      'popout' (default) | 'full'
 *   anchorRect   where the popout points; defaults to the element just clicked
 *   onOpenServer(serverId)   optional: navigate from the Mutual servers tab
 */
export default function UserProfileModal({
  user: initialUser, currentUser, member, roles = [], friend, isBlocked, serverId = null,
  onClose, onSendDM, onAddFriend, onAcceptFriend, onRemoveFriend, onBlock, onUnblock, onEditProfile, onToast,
  variant: initialVariant = 'popout', anchorRect = null, onOpenServer
}) {
  const [variant, setVariant] = useState(initialVariant);
  const [anchor] = useState(() => anchorRect ?? recentAnchorRect());
  // Mutual friends can be opened in place; `viewing` is whose profile is shown.
  const [viewing, setViewing] = useState(null);
  const user = viewing?.user ?? initialUser;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [replay, setReplay] = useState(0);
  const [reporting, setReporting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const mask = useStreamerMask();
  const sid = serverId && serverId !== 'home' ? serverId : null;
  const cachedIdentity = useIdentity(user?.id, sid);

  useEffect(() => {
    if (!user?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    fetchProfile(user.id, sid)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        if (res?.identity) primeIdentity(user.id, sid, res.identity);
      })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user?.id, sid]);

  const openUser = useCallback((id) => {
    const local = data?.mutual_friends?.find((f) => f.id === id);
    setViewing({ user: { id, ...(local ?? {}) } });
    setVariant('full');
  }, [data]);

  if (!user) return null;

  const shownUser = { ...user, ...(data?.user ?? {}) };
  const identity = data?.identity ?? cachedIdentity;
  const isSelf = user.id === currentUser?.id;
  const viewingOther = Boolean(viewing);
  const shownMember = viewingOther ? (data?.member ?? null) : { ...(member ?? {}), ...(data?.member ?? {}) };
  const shownRoles = viewingOther ? [] : (member?.roles ?? []);
  const topRole = shownRoles.find((r) => r.color && !r.name?.startsWith('@'));
  const usernameText = mask.usernames && !isSelf
    ? t('safety.streamerHidden')
    : `@${shownUser.username ?? ''}${shownUser.discriminator && !mask.personal ? `#${shownUser.discriminator}` : ''}`;
  const friendRow = viewingOther ? null : friend;
  const note = isSelf || mask.personal ? null : (
    <PrivateNote key={user.id} userId={user.id} initial={data?.my_note ?? user.my_note ?? ''} />
  );

  const actions = isSelf ? (
    <button
      type="button"
      onClick={onEditProfile}
      className="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded bg-d-brand px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-d-brandhover"
    >
      <Pencil className="h-4 w-4" aria-hidden="true" /> {t('profile.editProfile')}
    </button>
  ) : (
    <>
      <button
        type="button"
        onClick={() => onSendDM(shownUser)}
        className="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded bg-d-brand px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-d-brandhover"
      >
        <MessageSquare className="h-4 w-4" aria-hidden="true" /> {t('dm.message')}
      </button>
      {!isBlocked && !friendRow && !viewingOther && (
        <button
          type="button"
          onClick={() => onAddFriend(shownUser)}
          aria-label={variant === 'full' ? undefined : t('dm.addFriend')}
          title={t('dm.addFriend')}
          className="flex min-h-9 min-w-9 items-center justify-center gap-1.5 rounded bg-d-success px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-d-successhover"
        >
          <UserPlus className="h-4 w-4" aria-hidden="true" />{variant === 'full' && <span>{t('dm.addFriend')}</span>}
        </button>
      )}
      {friendRow?.friend_status === 'pending' && friendRow.direction === 'incoming' && (
        <button
          type="button"
          onClick={() => onAcceptFriend(shownUser)}
          className="flex min-h-9 items-center justify-center gap-1.5 rounded bg-d-success px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-d-successhover"
        >
          <Check className="h-4 w-4" aria-hidden="true" /> {t('dm.accept')}
        </button>
      )}
      {friendRow?.friend_status === 'accepted' && (
        <button
          type="button"
          aria-label={t('dm.removeFriend')}
          onClick={() => onRemoveFriend(shownUser)}
          className="flex min-h-9 min-w-9 items-center justify-center rounded bg-d-surface px-3 py-2 text-d-text2 transition-colors hover:bg-d-hover"
          title={t('dm.removeFriend')}
        >
          <UserMinus className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {!viewingOther && (
        <SafetyMenu
          isBlocked={isBlocked}
          onBlock={() => onBlock(shownUser)}
          onUnblock={() => onUnblock(shownUser)}
          onReport={() => setReporting(true)}
          onResetProfile={data?.viewer?.can_moderate && sid ? () => setResetting(true) : null}
        />
      )}
    </>
  );

  const guildEditor = isSelf && sid ? <GuildProfileEditor serverId={sid} onToast={onToast} /> : null;
  const shared = {
    user: shownUser,
    identity,
    member: shownMember,
    roles: shownRoles,
    roleColor: topRole?.color ?? null,
    usernameText,
    actions,
    replay,
    onReplay: () => setReplay((n) => n + 1)
  };

  return (
    <>
      {variant === 'full' ? (
        <ProfileFullModal
          {...shared}
          mutualServers={data?.mutual_servers ?? shownUser.mutual_servers ?? []}
          mutualFriends={data?.mutual_friends ?? []}
          note={note}
          extra={guildEditor}
          loading={loading}
          onClose={onClose}
          onOpenUser={openUser}
          onOpenServer={onOpenServer ? (id) => { onClose(); onOpenServer(id); } : undefined}
        />
      ) : (
        <ProfilePopout
          {...shared}
          anchorRect={anchor}
          onClose={onClose}
          onViewFull={() => setVariant('full')}
          footer={(
            <>
              {guildEditor && <div className="mt-3">{guildEditor}</div>}
              {note && <div className="mt-3">{note}</div>}
            </>
          )}
        />
      )}
      {reporting && (
        <ReportDialog
          target={{ type: 'user', id: shownUser.id }}
          user={isBlocked ? null : shownUser}
          where="user"
          onClose={() => setReporting(false)}
          onToast={onToast}
          // What the reporter saw goes with the report: profiles change.
          onDone={(report) => {
            if (report?.id) post(`/api/reports/${report.id}/profile-snapshot`, { server_id: sid }).catch(() => {});
          }}
        />
      )}
      {resetting && (
        <ConfirmModal
          title={t('profiles.resetTitle', { name: shownMember?.nickname || shownUser.display_name || shownUser.username })}
          body={t('profiles.resetBody')}
          confirmLabel={t('profiles.resetConfirm')}
          withReason
          reasonLabel={t('profiles.resetReason')}
          onClose={() => setResetting(false)}
          onConfirm={async (reason) => {
            await resetMemberProfile(sid, shownUser.id, { reason });
            onToast?.(t('profiles.resetDone'), { type: 'success', ttl: 3000 });
          }}
        />
      )}
    </>
  );
}

/**
 * "⋯" beside the profile actions: Block and Report, labelled, the way every
 * other messenger puts them — and, for moderators in a server, "Reset server
 * profile".
 */
function SafetyMenu({ isBlocked, onBlock, onUnblock, onReport, onResetProfile = null }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  useEscapeLayer(() => { setOpen(false); buttonRef.current?.focus(); }, open);

  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    const onDown = (e) => {
      if (!menuRef.current?.contains(e.target) && !buttonRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (e) => {
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    if (e.key === 'Tab') setOpen(false);
  };
  const pick = (fn) => () => { setOpen(false); fn(); };
  const item = 'flex w-full min-h-10 items-center gap-2 rounded px-2.5 text-left text-sm font-medium focus:outline-none';

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('safety.moreActions')}
        title={t('safety.moreActions')}
        className="flex h-full min-h-9 min-w-9 items-center justify-center rounded bg-d-surface px-2 text-d-text2 hover:bg-d-hover hover:text-d-strong"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('safety.moreActions')}
          onKeyDown={onKeyDown}
          className="absolute bottom-full right-0 z-10 mb-1 w-48 rounded-md border border-d-edge bg-d-sunken p-1.5 shadow-xl"
        >
          <button type="button" role="menuitem" onClick={pick(isBlocked ? onUnblock : onBlock)}
            className={`${item} ${isBlocked ? 'text-d-text hover:bg-d-hover focus:bg-d-hover' : 'text-d-danger hover:bg-d-danger hover:text-white focus:bg-d-danger focus:text-white'}`}>
            {isBlocked ? <ShieldOff className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
            {isBlocked ? t('dm.unblock') : t('dm.block')}
          </button>
          <button type="button" role="menuitem" onClick={pick(onReport)}
            className={`${item} text-d-danger hover:bg-d-danger hover:text-white focus:bg-d-danger focus:text-white`}>
            <Flag className="h-4 w-4" /> {t('safety.reportUser')}
          </button>
          {onResetProfile && (
            <button type="button" role="menuitem" onClick={pick(onResetProfile)}
              className={`${item} text-d-text hover:bg-d-hover focus:bg-d-hover`}>
              <Eraser className="h-4 w-4" /> {t('profiles.resetMenu')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A note only you can see, saved as you type.
 *
 * Debounced rather than saved on blur: closing the modal is the most common way
 * to leave the field, and blur does not fire reliably when the element unmounts
 * underneath the cursor. A 600ms debounce plus a flush on unmount covers both.
 */
/**
 * Your profile *in this server*: Discord lets you look different in each one.
 * Only the fields that differ are stored; anything left blank falls back to
 * the account profile, which is why the placeholders show what you would get.
 */
function GuildProfileEditor({ serverId, onToast }) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState(null);
  const [draft, setDraft] = useState({ nickname: '', bio: '', pronouns: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || profile) return;
    api(`/api/servers/${serverId}/profile/@me`)
      .then((p) => {
        setProfile(p);
        setDraft({ nickname: p.nickname ?? '', bio: p.bio ?? '', pronouns: p.pronouns ?? '' });
      })
      .catch((err) => onToast?.(err.message, { type: 'error' }));
  }, [open, profile, serverId, onToast]);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api(`/api/servers/${serverId}/profile/@me`, {
        method: 'PATCH',
        body: {
          nickname: draft.nickname.trim() || null,
          bio: draft.bio.trim() || null,
          pronouns: draft.pronouns.trim() || null
        }
      });
      setProfile(saved);
      onToast?.(t('profile.guildSaved'), { type: 'success', ttl: 2000 });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full bg-d-input text-d-strong rounded px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-d-brand';

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs font-bold text-d-text2 uppercase tracking-wider hover:text-d-strong"
      >
        {t('profile.guildProfile')}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wide text-d-text3 mb-0.5">{t('profile.guildNickname')}</span>
            <input
              value={draft.nickname}
              onChange={(e) => setDraft({ ...draft, nickname: e.target.value.slice(0, 32) })}
              placeholder={profile?.effective?.display_name ?? ''}
              className={field}
            />
          </label>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wide text-d-text3 mb-0.5">{t('profile.guildPronouns')}</span>
            <input
              value={draft.pronouns}
              onChange={(e) => setDraft({ ...draft, pronouns: e.target.value.slice(0, 40) })}
              placeholder={profile?.effective?.pronouns ?? ''}
              className={field}
            />
          </label>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wide text-d-text3 mb-0.5">{t('profile.guildBio')}</span>
            <textarea
              rows={2}
              value={draft.bio}
              onChange={(e) => setDraft({ ...draft, bio: e.target.value.slice(0, 300) })}
              placeholder={profile?.effective?.bio ?? ''}
              className={`${field} resize-none`}
            />
          </label>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="w-full bg-d-brand hover:bg-d-brand-hover disabled:opacity-50 text-white text-xs font-semibold py-1.5 rounded"
          >
            {t('common.save')}
          </button>
        </div>
      )}
    </div>
  );
}

function PrivateNote({ userId, initial = '' }) {
  const [note, setNote] = useState(initial ?? '');
  const [state, setState] = useState('idle');   // idle | saving | saved | error
  const timer = useRef(null);
  const latest = useRef(note);
  latest.current = note;

  const save = async (value) => {
    setState('saving');
    try {
      await api(`/api/users/${userId}/note`, { method: 'PUT', body: { note: value } });
      setState('saved');
      setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 1500);
    } catch {
      setState('error');
    }
  };

  const onChange = (value) => {
    setNote(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(value), 600);
  };

  // Flush a pending edit when the modal closes.
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      if (latest.current !== (initial ?? '')) {
        api(`/api/users/${userId}/note`, { method: 'PUT', body: { note: latest.current } }).catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h4 className="mb-1 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-d-text2">
        {t('profile.note')}
        <span className="text-[10px] font-normal normal-case tracking-normal text-d-text4">
          {state === 'saving' ? t('common.saving') : state === 'saved' ? t('common.saved') : state === 'error' ? t('common.saveFailed') : t('profile.noteOnlyYou')}
        </span>
      </h4>
      <textarea
        value={note}
        onChange={(e) => onChange(e.target.value)}
        maxLength={256}
        rows={2}
        placeholder={t('profile.notePlaceholder')}
        aria-label={t('profile.note')}
        className="w-full resize-none rounded-md border border-transparent bg-d-sunken px-2 py-1.5 text-xs
          text-d-text placeholder:text-d-text4 focus:border-d-brand focus:outline-none"
      />
    </div>
  );
}
