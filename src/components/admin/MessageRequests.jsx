import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, EyeOff, ShieldAlert, X, Mail, Loader2 } from 'lucide-react';
import { get, post } from '../../api';
import { t } from '../../i18n/index.jsx';
import { markdownToPlain } from '../../utils/plainText.js';
import { defaultAvatar } from '../../utils/avatar';
import { proxiedImageUrl } from '../../utils/media';
import ReportDialog from './ReportDialog';

/**
 * Message requests: 1:1 DMs from people who are not your friends wait here
 * until you accept, ignore, or block & report them (Discord / Instagram /
 * Signal). The server decides what is a request (GET /api/message-requests);
 * this hook just keeps a copy fresh and exposes the actions.
 *
 * `refreshKey` should change whenever the DM list or its unread state
 * changes, so a new request shows up without a reload.
 */
export function useMessageRequests(refreshKey) {
  const [state, setState] = useState({ enabled: false, blur_previews: false, requests: [] });
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(() => get('/api/message-requests')
    .then((data) => { if (alive.current && data) { setState(data); setLoaded(true); } })
    .catch(() => { if (alive.current) setLoaded(true); }), []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  const drop = (channelId) => setState((s) => ({ ...s, requests: s.requests.filter((r) => r.channel_id !== channelId) }));
  const accept = async (channelId) => { await post(`/api/message-requests/${channelId}/accept`); drop(channelId); };
  const ignore = async (channelId) => { await post(`/api/message-requests/${channelId}/ignore`); drop(channelId); };

  return { ...state, loaded, refresh, accept, ignore, drop };
}

/** One request in the DM sidebar. The preview is blurred for teens until tapped. */
export function MessageRequestRow({ request, blur, active, onOpen }) {
  const [revealed, setRevealed] = useState(false);
  const name = request.user.display_name || request.user.username;
  const preview = markdownToPlain(request.last_message?.content || '', {
    unknownUser: t('dm.unknownUser'), unknownChannel: t('search.unknownChannel'), spoiler: `[${t('chat.spoiler')}]`
  });
  const hidden = blur && !revealed;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpen(request.channel_id)}
        aria-current={active ? 'true' : undefined}
        className={`flex w-full min-h-11 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors ${
          active ? 'bg-d-active text-d-strong' : 'text-d-text2 hover:bg-d-hover/60 hover:text-d-text'
        }`}
      >
        <img src={proxiedImageUrl(request.user.avatar_url || defaultAvatar(request.user.id))} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold leading-tight">{name}</span>
          {hidden ? (
            <span className="flex items-center gap-1 text-[11px] text-d-text3 leading-tight">
              <EyeOff className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span aria-hidden="true" className="truncate blur-[3px] select-none">{preview.slice(0, 40) || '•••••'}</span>
              <span className="sr-only">{t('safety.previewHidden')}</span>
            </span>
          ) : (
            <span className="truncate text-[11px] text-d-text3 leading-tight">{preview || t('safety.requestMessages', { count: request.message_count })}</span>
          )}
        </span>
      </button>
      {hidden && preview && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1.5 py-1 text-[11px] font-semibold text-d-link hover:underline"
          aria-label={t('safety.showPreviewFrom', { name })}
        >
          {t('safety.show')}
        </button>
      )}
    </div>
  );
}

/**
 * The bar above a conversation that is still a request: who this is, and the
 * three choices. Replying also accepts (the server stops treating it as a
 * request once you have written in it).
 */
export function MessageRequestBar({ request, isMinor, onAccept, onIgnore, onReported, onToast }) {
  const [busy, setBusy] = useState(null);
  const [reporting, setReporting] = useState(false);
  const name = request.user.display_name || request.user.username;
  const run = (kind, fn) => async () => {
    setBusy(kind);
    try { await fn(); } catch (err) { onToast?.(err.message, { type: 'error' }); } finally { setBusy(null); }
  };
  const btn = 'flex min-h-10 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-semibold transition-colors disabled:opacity-50';

  return (
    <section
      aria-label={t('safety.messageRequest')}
      className="shrink-0 border-b border-d-edge bg-d-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Mail className="h-5 w-5 shrink-0 text-d-brand" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-d-strong">{t('safety.requestFrom', { name })}</p>
          <p className="text-xs text-d-text2 leading-relaxed">
            {t('safety.requestContext', { count: request.mutual_server_count })}
            {isMinor ? ` ${t('safety.requestTeenTip')}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={Boolean(busy)} onClick={run('accept', onAccept)} className={`${btn} bg-d-brand text-white hover:bg-d-brandhover`}>
            {busy === 'accept' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {t('safety.accept')}
          </button>
          <button type="button" disabled={Boolean(busy)} onClick={run('ignore', onIgnore)} className={`${btn} bg-d-control2 text-d-strong hover:bg-d-control`}>
            {busy === 'ignore' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} {t('safety.ignore')}
          </button>
          <button type="button" disabled={Boolean(busy)} onClick={() => setReporting(true)} className={`${btn} bg-d-danger text-white hover:bg-d-dangerhover`}>
            <ShieldAlert className="h-4 w-4" /> {t('safety.blockAndReport')}
          </button>
        </div>
      </div>
      {reporting && (
        <ReportDialog
          target={request.last_message ? { type: 'message', id: request.last_message.id } : { type: 'user', id: request.user.id }}
          user={request.user}
          where="dm"
          onClose={() => setReporting(false)}
          onToast={onToast}
          onDone={() => onReported?.()}
        />
      )}
    </section>
  );
}
