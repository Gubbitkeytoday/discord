import React, { useMemo, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t } from '../i18n/index.jsx';
import { DEFAULT_AVATAR } from '../utils/avatar';

const FALLBACK_AVATAR = DEFAULT_AVATAR;
const MAX_RECIPIENTS = 9; // Discord caps a group DM at 10 people including you

/**
 * "Create group DM" / "Add friends to DM". Selecting people from an existing
 * 1:1 conversation upgrades it into a group, exactly as Discord does.
 */
export default function CreateGroupDmModal({ friends = [], existing = null, onCreate, onClose }) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useFocusTrap(true, onClose);

  const alreadyIn = useMemo(
    () => new Set((existing?.recipients ?? []).map((r) => r.id)),
    [existing]
  );

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return friends
      .filter((f) => !alreadyIn.has(f.id))
      .filter((f) => !needle
        || (f.display_name ?? '').toLowerCase().includes(needle)
        || (f.username ?? '').toLowerCase().includes(needle));
  }, [friends, filter, alreadyIn]);

  const toggle = (id) => setSelected((prev) => {
    if (prev.includes(id)) return prev.filter((x) => x !== id);
    if (prev.length + alreadyIn.size >= MAX_RECIPIENTS) return prev;
    return [...prev, id];
  });

  const submit = async (e) => {
    e.preventDefault();
    if (!selected.length) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(selected, name.trim());
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center overlay-center p-4">
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={existing ? t('dm.addToGroup') : t('dm.createGroup')}
        onSubmit={submit}
        className="bg-d-canvas w-full max-w-md rounded-lg shadow-2xl border border-d-surface overflow-hidden flex flex-col max-h-[80vh]"
      >
        <div className="p-4 border-b border-d-divider flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-d-strong">
              {existing ? t('dm.addToGroup') : t('dm.createGroup')}
            </h2>
            <p className="text-[11px] text-d-text3">
              {t('dm.groupCapacity', { count: MAX_RECIPIENTS - alreadyIn.size - selected.length })}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 border-b border-d-divider relative">
          <Search className="w-4 h-4 text-d-text4 absolute left-6 top-1/2 -translate-y-1/2" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('dm.findFriends')}
            autoFocus
            className="w-full bg-d-base text-sm text-d-strong pl-9 pr-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {visible.length === 0 && <p className="text-xs text-d-text4 p-3">{t('dm.noFriendsToAdd')}</p>}
          {visible.map((friend) => (
            <button
              type="button"
              key={friend.id}
              onClick={() => toggle(friend.id)}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded text-left transition-colors ${
                selected.includes(friend.id) ? 'bg-d-active' : 'hover:bg-d-hover/60'
              }`}
            >
              <img src={friend.avatar_url || FALLBACK_AVATAR} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-d-strong truncate">{friend.display_name || friend.username}</span>
                <span className="block text-[11px] text-d-text3 truncate">@{friend.username}</span>
              </span>
              <span className={`w-4 h-4 rounded border shrink-0 ${selected.includes(friend.id) ? 'bg-d-brand border-d-brand' : 'border-d-text4'}`} />
            </button>
          ))}
        </div>

        <div className="p-3 border-t border-d-divider space-y-2">
          {!existing && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder={t('dm.groupNameOptional')}
              className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
            />
          )}
          {error && <p className="text-xs text-d-danger">{error}</p>}
          <button
            type="submit"
            disabled={busy || selected.length === 0}
            className="w-full bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white text-sm font-semibold py-2 rounded flex items-center justify-center gap-2 transition-colors"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {existing ? t('dm.addPeople') : t('dm.createGroup')}
          </button>
        </div>
      </form>
    </div>
  );
}
