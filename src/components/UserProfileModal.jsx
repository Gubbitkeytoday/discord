import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  X, MessageSquare, UserPlus, UserMinus, ShieldAlert, ShieldOff, Pencil, Check
} from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { localeTag, t } from '../i18n/index.jsx';
import { DEFAULT_AVATAR } from '../utils/avatar';

const FALLBACK_AVATAR = DEFAULT_AVATAR;

const STATUS_COLORS = {
  online: 'bg-d-online', idle: 'bg-d-idle', dnd: 'bg-d-danger',
  offline: 'bg-d-text4', invisible: 'bg-d-text4'
};

export default function UserProfileModal({
  user, currentUser, member, roles = [], friend, isBlocked,
  onClose, onSendDM, onAddFriend, onAcceptFriend, onRemoveFriend, onBlock, onUnblock, onEditProfile
}) {
  const dialogRef = useFocusTrap(true, onClose);
  if (!user) return null;

  const isSelf = user.id === currentUser?.id;
  // Roles come from the member record; @everyone is never shown, as on Discord.
  const memberRoles = (member?.roles ?? []).filter((r) => !r.name.startsWith('@'));
  const joined = member?.joined_at ?? null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[60] flex items-center justify-center overlay-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={user.display_name || user.username}
        className="bg-d-panel w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl border border-d-canvas relative"
      >
        <div
          className="h-28 bg-cover bg-center relative"
          style={{
            backgroundImage: user.banner_url ? `url(${user.banner_url})` : undefined,
            backgroundColor: user.accent_color || 'var(--color-d-brand)'
          }}
        >
          <button
            onClick={onClose}
            className="absolute top-3 right-3 bg-black/40 hover:bg-black/70 p-1.5 rounded-full text-white transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 pt-0 relative">
          <div className="relative -top-10 mb-[-2rem] flex justify-between items-end">
            <div className="relative">
              <img
                src={user.avatar_url || FALLBACK_AVATAR}
                alt=""
                className="w-20 h-20 rounded-full border-4 border-d-panel object-cover"
              />
              <span
                className={`absolute bottom-1 right-1 w-4 h-4 rounded-full border-2 border-d-panel ${
                  STATUS_COLORS[user.status] ?? STATUS_COLORS.offline
                }`}
                title={t(`status.${user.status ?? 'offline'}`)}
              />
            </div>
          </div>

          <div className="mt-4 bg-d-sunken p-4 rounded-xl border border-d-surface space-y-3">
            <div>
              <h3 className="text-xl font-bold text-d-strong leading-tight">
                {member?.nickname || user.display_name || user.username}
              </h3>
              <p className="text-xs text-d-text3">
                @{user.username}{user.discriminator ? `#${user.discriminator}` : ''}
              </p>
              {user.pronouns && <p className="text-[11px] text-d-text3 mt-0.5">{user.pronouns}</p>}
              {user.custom_status && <p className="text-xs text-d-text mt-1">{user.custom_status}</p>}
            </div>

            <div className="w-full h-[1px] bg-d-surface" />

            <div>
              <h4 className="text-xs font-bold text-d-text2 uppercase tracking-wider mb-1">{t('profile.aboutMe')}</h4>
              {user.profile_hidden ? (
                <p className="text-xs italic text-d-text3">{t('profile.hidden')}</p>
              ) : (
                <p className="text-xs text-d-text leading-relaxed whitespace-pre-wrap">
                  {user.bio || t('profile.noBio')}
                </p>
              )}
            </div>

            {!isSelf && <PrivateNote userId={user.id} initial={user.my_note} />}

            {memberRoles.length > 0 && (
              <div>
                <h4 className="text-xs font-bold text-d-text2 uppercase tracking-wider mb-1">
                  {t('profile.roles', { count: memberRoles.length })}
                </h4>
                <div className="flex flex-wrap gap-1">
                  {memberRoles.map((role) => (
                    <span
                      key={role.id}
                      className="flex items-center gap-1 bg-d-surface text-d-text border border-d-divider text-[11px] font-semibold px-2 py-0.5 rounded"
                    >
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: role.color || 'var(--color-d-text4)' }}
                        aria-hidden="true"
                      />
                      {role.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 text-[11px] text-d-text3">
              {joined && (
                <div>
                  <span className="block font-bold text-d-text2 uppercase">{t('profile.memberSince')}</span>
                  {new Date(joined).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short', year: 'numeric' })}
                </div>
              )}
              {user.created_at && (
                <div>
                  <span className="block font-bold text-d-text2 uppercase">{t('profile.discordSince')}</span>
                  {new Date(user.created_at).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short', year: 'numeric' })}
                </div>
              )}
            </div>

            <div className="w-full h-[1px] bg-d-surface" />

            <div className="flex flex-wrap gap-2">
              {isSelf ? (
                <button
                  onClick={onEditProfile}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-d-brand hover:bg-d-brandhover text-white text-xs font-semibold px-3 py-2 rounded transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" /> {t('profile.editProfile')}
                </button>
              ) : (
                <>
                  <button
                    onClick={() => onSendDM(user)}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-d-brand hover:bg-d-brandhover text-white text-xs font-semibold px-3 py-2 rounded transition-colors"
                  >
                    <MessageSquare className="w-3.5 h-3.5" /> {t('dm.message')}
                  </button>

                  {!isBlocked && !friend && (
                    <button
                      onClick={() => onAddFriend(user)}
                      className="flex items-center justify-center gap-1.5 bg-d-success hover:bg-d-successhover text-white text-xs font-semibold px-3 py-2 rounded transition-colors"
                    >
                      <UserPlus className="w-3.5 h-3.5" /> {t('dm.addFriend')}
                    </button>
                  )}
                  {friend?.friend_status === 'pending' && friend.direction === 'incoming' && (
                    <button
                      onClick={() => onAcceptFriend(user)}
                      className="flex items-center justify-center gap-1.5 bg-d-success hover:bg-d-successhover text-white text-xs font-semibold px-3 py-2 rounded transition-colors"
                    >
                      <Check className="w-3.5 h-3.5" /> {t('dm.accept')}
                    </button>
                  )}
                  {friend?.friend_status === 'accepted' && (
                    <button
                      onClick={() => onRemoveFriend(user)}
                      className="flex items-center justify-center gap-1.5 bg-d-surface hover:bg-d-hover text-d-text2 text-xs font-semibold px-3 py-2 rounded transition-colors"
                      title={t('dm.removeFriend')}
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <button
                    onClick={() => (isBlocked ? onUnblock(user) : onBlock(user))}
                    className="flex items-center justify-center gap-1.5 bg-d-surface hover:bg-d-danger hover:text-white text-d-text2 text-xs font-semibold px-3 py-2 rounded transition-colors"
                    title={isBlocked ? t('dm.unblock') : t('dm.block')}
                  >
                    {isBlocked ? <ShieldOff className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
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
