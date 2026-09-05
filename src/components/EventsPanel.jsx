// ============================================================================
//  Scheduled events — the list, one card, and the create/edit form.
//
//  Discord opens this from the server header. The list is forward-looking:
//  live first, then upcoming by start time. "Interested" is the only action a
//  regular member has, and it toggles in place without a round trip because
//  waiting on the network to see your own tick move makes a button feel broken.
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  Calendar, Clock, MapPin, Volume2, Users, Plus, X, Loader2, Pencil, Ban, Bell, Check
} from 'lucide-react';
import { api, get } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t, localeTag } from '../i18n/index.jsx';

const fmtDate = (iso) => new Date(iso).toLocaleString(localeTag(), {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
});

/** "in 3 hours" / "in 2 days" / "started 5 minutes ago" */
function relative(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60000);
  const unit = minutes < 60 ? t('events.minutes', { count: minutes })
    : minutes < 60 * 24 ? t('events.hours', { count: Math.round(minutes / 60) })
    : t('events.days', { count: Math.round(minutes / 60 / 24) });
  return diff >= 0 ? t('events.startsIn', { when: unit }) : t('events.startedAgo', { when: unit });
}

/* --- panel ------------------------------------------------------------------ */

export default function EventsPanel({ server, channels = [], canManage, socket, onClose, onJoinVoice, onToast }) {
  const [events, setEvents] = useState(null);
  const [showPast, setShowPast] = useState(false);
  const [editing, setEditing] = useState(null);   // null | 'new' | event
  const dialogRef = useFocusTrap(true, onClose);

  const load = () => {
    if (!server?.id) return;
    get(`/api/servers/${server.id}/events${showPast ? '?past=1' : ''}`)
      .then((list) => setEvents(Array.isArray(list) ? list : []))
      .catch((err) => { setEvents([]); onToast?.(err.message, { type: 'error' }); });
  };

  useEffect(load, [server?.id, showPast]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Stay live: someone else creating, editing or showing interest updates the
  // list in place.
  useEffect(() => {
    if (!socket) return undefined;
    const upsert = (event) => {
      if (event.server_id !== server?.id) return;
      setEvents((current) => {
        if (!current) return current;
        const exists = current.some((e) => e.id === event.id);
        const next = exists ? current.map((e) => (e.id === event.id ? { ...e, ...event, interested: e.interested } : e))
                            : [...current, event];
        return next;
      });
    };
    const interest = ({ event_id, interested_count }) =>
      setEvents((current) => current?.map((e) => (e.id === event_id ? { ...e, interested_count } : e)) ?? current);
    socket.on('event_created', upsert);
    socket.on('event_updated', upsert);
    socket.on('event_interest', interest);
    return () => {
      socket.off('event_created', upsert);
      socket.off('event_updated', upsert);
      socket.off('event_interest', interest);
    };
  }, [socket, server?.id]);

  const toggleInterest = async (event) => {
    const next = !event.interested;
    setEvents((current) => current.map((e) => (e.id === event.id
      ? { ...e, interested: next, interested_count: Math.max(0, e.interested_count + (next ? 1 : -1)) }
      : e)));
    try {
      const fresh = await api(`/api/events/${event.id}/interest`, { method: 'PUT', body: { interested: next } });
      setEvents((current) => current.map((e) => (e.id === event.id ? fresh : e)));
    } catch (err) {
      setEvents((current) => current.map((e) => (e.id === event.id ? event : e)));
      onToast?.(err.message, { type: 'error' });
    }
  };

  const cancel = async (event) => {
    try {
      const fresh = await api(`/api/events/${event.id}`, { method: 'DELETE' });
      setEvents((current) => current.map((e) => (e.id === event.id ? fresh : e)));
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    }
  };

  const sorted = useMemo(() => {
    if (!events) return [];
    const rank = { active: 0, scheduled: 1, completed: 2, cancelled: 3 };
    return [...events].sort((a, b) =>
      (rank[a.status] - rank[b.status]) || a.starts_at.localeCompare(b.starts_at));
  }, [events]);

  const voiceChannels = channels.filter((c) => ['voice', 'stage'].includes(c.type));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overlay-center bg-black/70 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('events.title')}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-d-divider
          bg-d-canvas shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-d-divider px-5 py-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-d-strong">
            <Calendar className="h-5 w-5" aria-hidden="true" /> {t('events.title')}
            {events && (
              <span className="rounded-full bg-d-surface px-2 py-0.5 text-xs font-medium text-d-text2">
                {events.filter((e) => e.status === 'scheduled' || e.status === 'active').length}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            {canManage && (
              <button
                onClick={() => setEditing('new')}
                className="flex items-center gap-1.5 rounded-lg bg-d-brand px-3 py-1.5 text-sm font-medium
                  text-white hover:bg-d-brandhover"
              >
                <Plus className="h-4 w-4" /> {t('events.create')}
              </button>
            )}
            <button
              onClick={onClose}
              aria-label={t('common.close')}
              className="rounded p-1.5 text-d-text3 hover:bg-d-hover hover:text-d-strong"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {events === null && (
            <div className="flex justify-center py-12 text-d-text3"><Loader2 className="h-5 w-5 animate-spin" /></div>
          )}

          {events?.length === 0 && (
            <div className="py-12 text-center">
              <Calendar className="mx-auto mb-3 h-10 w-10 text-d-text4" aria-hidden="true" />
              <p className="text-sm font-medium text-d-strong">{t('events.emptyTitle')}</p>
              <p className="mt-1 text-sm text-d-text3">
                {canManage ? t('events.emptyManager') : t('events.emptyMember')}
              </p>
            </div>
          )}

          {sorted.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              canManage={canManage}
              onInterest={() => toggleInterest(event)}
              onEdit={() => setEditing(event)}
              onCancel={() => cancel(event)}
              onJoin={event.channel_id && onJoinVoice ? () => onJoinVoice(event.channel_id) : null}
            />
          ))}
        </div>

        <footer className="border-t border-d-divider px-5 py-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-d-text2">
            <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)}
              className="accent-d-brand" />
            {t('events.showPast')}
          </label>
        </footer>
      </div>

      {editing && (
        <EventForm
          server={server}
          event={editing === 'new' ? null : editing}
          voiceChannels={voiceChannels}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEvents((current) => {
              const exists = current?.some((e) => e.id === saved.id);
              return exists ? current.map((e) => (e.id === saved.id ? saved : e)) : [...(current ?? []), saved];
            });
            setEditing(null);
          }}
          onToast={onToast}
        />
      )}
    </div>
  );
}

/* --- card ----------------------------------------------------------------- */

function EventCard({ event, canManage, onInterest, onEdit, onCancel, onJoin }) {
  const live = event.status === 'active';
  const over = event.status === 'completed' || event.status === 'cancelled';

  return (
    <article
      className={`rounded-lg border bg-d-surface p-4 ${
        live ? 'border-d-online' : over ? 'border-d-divider opacity-60' : 'border-d-divider'
      }`}
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs font-semibold">
            {live ? (
              <span className="flex items-center gap-1 text-d-online">
                <span className="h-2 w-2 animate-pulse rounded-full bg-d-online" /> {t('events.live')}
              </span>
            ) : over ? (
              <span className="text-d-text3">{t(`events.status_${event.status}`)}</span>
            ) : (
              <span className="flex items-center gap-1 text-d-brand">
                <Clock className="h-3.5 w-3.5" /> {relative(event.starts_at)}
              </span>
            )}
            <span className="text-d-text3">· {fmtDate(event.starts_at)}</span>
          </div>

          <h3 className="text-base font-semibold leading-snug text-d-strong">{event.name}</h3>

          {event.description && (
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-d-text2">{event.description}</p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-d-text3">
            {event.channel ? (
              <span className="flex items-center gap-1"><Volume2 className="h-3.5 w-3.5" /> {event.channel.name}</span>
            ) : event.location ? (
              <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> {event.location}</span>
            ) : null}
            <span className="flex items-center gap-1">
              <Users className="h-3.5 w-3.5" /> {t('events.interestedCount', { count: event.interested_count })}
            </span>
            {event.creator && (
              <span>{t('events.by', { name: event.creator.display_name || event.creator.username })}</span>
            )}
          </div>
        </div>

        {event.image_url && (
          <img src={event.image_url} alt="" className="h-20 w-32 shrink-0 rounded-md object-cover" />
        )}
      </div>

      {!over && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={onInterest}
            aria-pressed={event.interested}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium
              transition-colors ${event.interested
                ? 'border-d-brand bg-d-brand/15 text-d-mention'
                : 'border-d-divider text-d-text2 hover:border-d-control hover:text-d-strong'}`}
          >
            {event.interested ? <Check className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
            {event.interested ? t('events.interested') : t('events.markInterested')}
          </button>

          {live && onJoin && (
            <button
              onClick={onJoin}
              className="flex items-center gap-1.5 rounded-lg bg-d-online px-3 py-1.5 text-sm font-medium
                text-white hover:brightness-110"
            >
              <Volume2 className="h-4 w-4" /> {t('events.join')}
            </button>
          )}

          {canManage && (
            <span className="ml-auto flex items-center gap-1">
              {!live && (
                <button onClick={onEdit} aria-label={t('common.edit')} title={t('common.edit')}
                  className="rounded p-1.5 text-d-text3 hover:bg-d-hover hover:text-d-strong">
                  <Pencil className="h-4 w-4" />
                </button>
              )}
              <button onClick={onCancel} aria-label={live ? t('events.end') : t('events.cancel')}
                title={live ? t('events.end') : t('events.cancel')}
                className="rounded p-1.5 text-d-text3 hover:bg-d-hover hover:text-d-danger">
                <Ban className="h-4 w-4" />
              </button>
            </span>
          )}
        </div>
      )}
    </article>
  );
}

/* --- form ----------------------------------------------------------------- */

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in local time, not ISO/UTC. */
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function EventForm({ server, event, voiceChannels, onClose, onSaved, onToast }) {
  const [form, setForm] = useState({
    name: event?.name ?? '',
    description: event?.description ?? '',
    where: event?.channel_id ? 'channel' : 'external',
    channel_id: event?.channel_id ?? voiceChannels[0]?.id ?? '',
    location: event?.location ?? '',
    starts_at: toLocalInput(event?.starts_at) || toLocalInput(new Date(Date.now() + 3600_000).toISOString()),
    ends_at: toLocalInput(event?.ends_at)
  });
  const [busy, setBusy] = useState(false);
  const dialogRef = useFocusTrap(true, onClose);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const valid = form.name.trim() && form.starts_at
    && (form.where === 'channel' ? form.channel_id : form.location.trim());

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      channel_id: form.where === 'channel' ? form.channel_id : null,
      location: form.where === 'external' ? form.location.trim() : null,
      starts_at: new Date(form.starts_at).toISOString(),
      ends_at: form.ends_at ? new Date(form.ends_at).toISOString() : null
    };
    try {
      const saved = event
        ? await api(`/api/events/${event.id}`, { method: 'PATCH', body: payload })
        : await api(`/api/servers/${server.id}/events`, { method: 'POST', body: payload });
      onSaved(saved);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
      setBusy(false);
    }
  };

  const field = 'w-full rounded-lg border border-transparent bg-d-sunken px-3 py-2.5 text-sm text-d-strong '
    + 'placeholder:text-d-text4 focus:border-d-brand focus:outline-none';
  const label = 'mb-2 block text-xs font-bold uppercase tracking-wide text-d-text2';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center overlay-center bg-black/60 p-4">
      <form
        ref={dialogRef}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label={event ? t('events.edit') : t('events.create')}
        className="w-full max-w-lg rounded-xl border border-d-divider bg-d-canvas shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-d-divider px-5 py-4">
          <h2 className="text-lg font-semibold text-d-strong">{event ? t('events.edit') : t('events.create')}</h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')}
            className="rounded p-1.5 text-d-text3 hover:bg-d-hover hover:text-d-strong"><X className="h-5 w-5" /></button>
        </header>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className={label}>{t('events.name')}</span>
            <input autoFocus value={form.name} maxLength={100} onChange={(e) => set({ name: e.target.value })}
              placeholder={t('events.namePlaceholder')} className={field} />
          </label>

          <div>
            <span className={label}>{t('events.where')}</span>
            <div role="radiogroup" className="grid grid-cols-2 gap-2">
              {[
                { key: 'channel', icon: Volume2, text: t('events.whereChannel'), disabled: voiceChannels.length === 0 },
                { key: 'external', icon: MapPin, text: t('events.whereExternal') }
              ].map((opt) => (
                <button key={opt.key} type="button" role="radio" aria-checked={form.where === opt.key}
                  disabled={opt.disabled} onClick={() => set({ where: opt.key })}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors
                    disabled:opacity-40 ${form.where === opt.key
                      ? 'border-d-brand bg-d-brand/10 text-d-strong'
                      : 'border-d-divider bg-d-surface text-d-text2 hover:border-d-control'}`}>
                  <opt.icon className="h-4 w-4" /> {opt.text}
                </button>
              ))}
            </div>
          </div>

          {form.where === 'channel' ? (
            <label className="block">
              <span className={label}>{t('events.channel')}</span>
              <select value={form.channel_id} onChange={(e) => set({ channel_id: e.target.value })}
                className={`${field} cursor-pointer`}>
                {voiceChannels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          ) : (
            <label className="block">
              <span className={label}>{t('events.location')}</span>
              <input value={form.location} maxLength={100} onChange={(e) => set({ location: e.target.value })}
                placeholder={t('events.locationPlaceholder')} className={field} />
            </label>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className={label}>{t('events.startsAt')}</span>
              <input type="datetime-local" value={form.starts_at} onChange={(e) => set({ starts_at: e.target.value })}
                className={field} />
            </label>
            <label className="block">
              <span className={label}>{t('events.endsAt')} <span className="font-normal normal-case text-d-text4">({t('common.optional')})</span></span>
              <input type="datetime-local" value={form.ends_at} onChange={(e) => set({ ends_at: e.target.value })}
                className={field} />
            </label>
          </div>

          <label className="block">
            <span className={label}>{t('events.description')}</span>
            <textarea value={form.description} rows={3} maxLength={1000}
              onChange={(e) => set({ description: e.target.value })} className={`${field} resize-none`} />
          </label>
        </div>

        <footer className="flex justify-end gap-3 border-t border-d-divider px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium text-d-text2 hover:underline">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={!valid || busy}
            className="flex items-center gap-2 rounded-lg bg-d-brand px-5 py-2 text-sm font-medium text-white
              hover:bg-d-brandhover disabled:cursor-not-allowed disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {event ? t('common.saveChanges') : t('events.create')}
          </button>
        </footer>
      </form>
    </div>
  );
}
