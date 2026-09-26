import React, { useEffect, useState } from 'react';
import { Radio, Volume2, MapPin, ChevronRight } from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import { get } from '../../api';
import { proxiedImageUrl } from '../../utils/media';

/**
 * A server's scheduled events, kept live over the socket. For the channel
 * list's "Events (n)" row and live banner:
 *
 *   const events = useServerEvents(server?.id, socket);
 *   const live = events.filter((e) => e.status === 'active');
 */
export function useServerEvents(serverId, socket) {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    if (!serverId) { setEvents([]); return undefined; }
    let alive = true;
    get(`/api/servers/${serverId}/events`)
      .then((list) => { if (alive) setEvents(Array.isArray(list) ? list : []); })
      .catch(() => { if (alive) setEvents([]); });
    if (!socket) return () => { alive = false; };
    const upsert = (event) => {
      if (event?.server_id !== serverId) return;
      setEvents((current) => (current.some((e) => e.id === event.id)
        ? current.map((e) => (e.id === event.id ? { ...e, ...event } : e))
        : [...current, event]));
    };
    socket.on('event_created', upsert);
    socket.on('event_updated', upsert);
    return () => {
      alive = false;
      socket.off('event_created', upsert);
      socket.off('event_updated', upsert);
    };
  }, [serverId, socket]);
  return events;
}

/**
 * "Live now" card for an event that has started — at the top of the channel
 * list and of the Events panel. Green like Discord's; the dot pulses only
 * when motion is allowed (the global reduced-motion rule stops it).
 *
 *   <LiveEventBanner event={live} onOpen={openEvents} onJoin={() => joinVoice(live.channel_id)} />
 */
export default function LiveEventBanner({ event, onOpen, onJoin, compact = false, className = '' }) {
  if (!event) return null;
  const where = event.channel?.name ?? event.location ?? null;
  const WhereIcon = event.channel_id ? Volume2 : MapPin;
  return (
    <div className={`rounded-lg border border-d-online/60 bg-d-online/10 overflow-hidden ${className}`}>
      {!compact && event.image_url && (
        <img src={proxiedImageUrl(event.image_url)} alt="" className="w-full aspect-[16/6] object-cover" />
      )}
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          onClick={onOpen}
          className="flex-1 min-w-0 min-h-10 flex items-center gap-2 text-left rounded px-1 hover:bg-d-online/10"
        >
          <span className="relative flex w-2.5 h-2.5 shrink-0" aria-hidden="true">
            <span className="absolute inset-0 rounded-full bg-d-online animate-ping opacity-60" />
            <span className="relative w-2.5 h-2.5 rounded-full bg-d-online" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 text-[11px] font-bold uppercase text-d-onlinetext">
              <Radio className="w-3 h-3" aria-hidden="true" /> {t('srv.liveNow')}
            </span>
            <span className="block text-sm font-semibold text-d-strong truncate">{event.name}</span>
            {where && (
              <span className="flex items-center gap-1 text-xs text-d-text2 truncate">
                <WhereIcon className="w-3 h-3 shrink-0" aria-hidden="true" /> {where}
              </span>
            )}
          </span>
          <ChevronRight className="w-4 h-4 text-d-text3 shrink-0" aria-hidden="true" />
        </button>
        {onJoin && event.channel_id && (
          <button
            type="button"
            onClick={onJoin}
            className="shrink-0 min-h-8 px-3 rounded bg-d-success hover:bg-d-successhover text-white text-sm font-medium"
          >
            {t('events.join')}
          </button>
        )}
      </div>
    </div>
  );
}
