// ============================================================================
//  Poll, as it appears inside a message.
//
//  Discord's behaviour, and the reasons behind the choices here:
//
//   - The tally is always visible, before and after you vote. There is no
//     "reveal" step to get wrong, and seeing the numbers is most of the point.
//   - Clicking an answer you already picked retracts it. That is not obvious
//     from the UI alone, so the answer row is a real toggle: `aria-pressed`
//     tells a screen reader the state, and the tick is visible without colour.
//   - The vote is optimistic. A poll is a snap decision; waiting a round trip to
//     see your own tick move makes it feel broken. The server's answer replaces
//     the guess when it lands, and a failure rolls it back with a toast.
//   - Percentages are of *voters*, not of votes, so a multiple-choice poll can
//     legitimately add up to more than 100%.
// ============================================================================

import React, { useEffect, useState } from 'react';
import { BarChart3, Check, Clock, Users, Lock } from 'lucide-react';
import { api } from '../api';
import { t, localeTag } from '../i18n/index.jsx';

/** "2 days left" / "4 hours left" / "12 minutes left". */
function formatRemaining(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return t('poll.minutesLeft', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('poll.hoursLeft', { count: hours });
  return t('poll.daysLeft', { count: Math.floor(hours / 24) });
}

export default function PollCard({ poll: incoming, currentUserId, canManage = false, onToast }) {
  const [poll, setPoll] = useState(incoming);
  const [busy, setBusy] = useState(false);
  const [voters, setVoters] = useState(null);   // { answerId, list } once expanded

  // The gateway pushes a fresh tally on every vote from anyone. It deliberately
  // omits `my_votes` — that is per-viewer — so keep the local copy.
  useEffect(() => {
    setPoll((current) => (incoming ? { ...incoming, my_votes: current?.my_votes ?? incoming.my_votes } : current));
  }, [incoming]);

  if (!poll) return null;

  const closed = poll.is_closed;
  const mine = new Set(poll.my_votes ?? []);
  const remaining = !closed && poll.expires_at ? formatRemaining(poll.expires_at) : null;
  const leading = Math.max(0, ...poll.answers.map((a) => a.votes));

  const toggle = async (answerId) => {
    if (closed || busy) return;

    const next = new Set(mine);
    if (next.has(answerId)) next.delete(answerId);
    else {
      if (!poll.allow_multiple) next.clear();
      next.add(answerId);
    }
    const wanted = [...next];

    // Optimistic: move the tick and the bar now, reconcile when the server answers.
    const before = poll;
    setPoll((current) => ({
      ...current,
      my_votes: wanted,
      answers: current.answers.map((a) => {
        const had = mine.has(a.id);
        const has = next.has(a.id);
        if (had === has) return a;
        return { ...a, votes: Math.max(0, a.votes + (has ? 1 : -1)) };
      })
    }));

    setBusy(true);
    try {
      const fresh = await api(`/api/polls/${poll.message_id}/vote`, {
        method: 'PUT', body: { answer_ids: wanted }
      });
      setPoll(fresh);
    } catch (err) {
      setPoll(before);          // the optimistic move was a guess, and it was wrong
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    setBusy(true);
    try {
      setPoll(await api(`/api/polls/${poll.message_id}/close`, { method: 'POST' }));
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const showVoters = async (answerId) => {
    if (voters?.answerId === answerId) { setVoters(null); return; }
    try {
      const list = await api(`/api/polls/${poll.message_id}/answers/${answerId}/voters`);
      setVoters({ answerId, list });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    }
  };

  return (
    <div className="mt-2 max-w-md rounded-lg border border-d-divider bg-d-surface p-4">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-d-text3">
        <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
        {poll.allow_multiple ? t('poll.multipleChoice') : t('poll.singleChoice')}
      </div>

      <h4 className="mb-3 text-base font-semibold leading-snug text-d-strong">{poll.question}</h4>

      <div role="group" aria-label={poll.question} className="space-y-2">
        {poll.answers.map((answer) => {
          const picked = mine.has(answer.id);
          const isLeading = closed && answer.votes === leading && leading > 0;
          return (
            <div key={answer.id}>
              <button
                type="button"
                aria-pressed={picked}
                disabled={closed || busy}
                onClick={() => toggle(answer.id)}
                className={`relative w-full overflow-hidden rounded-md border px-3 py-2.5 text-left
                  transition-colors disabled:cursor-default
                  ${picked ? 'border-d-brand' : 'border-d-divider hover:border-d-control'}
                  ${closed ? '' : 'cursor-pointer'}`}
              >
                {/* The bar is a background layer so the label never reflows as
                    numbers change — text that jumps while you read it is worse
                    than a bar that animates. */}
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-0 left-0 transition-[width] duration-300
                    ${isLeading ? 'bg-d-brand/25' : 'bg-d-brand/10'}`}
                  style={{ width: `${answer.percent}%` }}
                />
                <span className="relative flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2
                      ${picked ? 'border-d-brand bg-d-brand' : 'border-d-control'}`}
                  >
                    {picked && <Check className="h-2.5 w-2.5 text-white" strokeWidth={4} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-d-strong">
                    {answer.emoji ? `${answer.emoji} ` : ''}{answer.text}
                  </span>
                  <span className="shrink-0 text-xs font-semibold tabular-nums text-d-text2">
                    {answer.percent}%
                  </span>
                </span>
              </button>

              <button
                type="button"
                onClick={() => showVoters(answer.id)}
                className="mt-0.5 pl-3 text-[11px] text-d-text3 hover:text-d-strong hover:underline"
              >
                {t('poll.voteCount', { count: answer.votes })}
              </button>

              {voters?.answerId === answer.id && (
                <ul className="mt-1 space-y-1 pl-3">
                  {voters.list.length === 0 && (
                    <li className="text-[11px] text-d-text3">{t('poll.noVotesYet')}</li>
                  )}
                  {voters.list.map((voter) => (
                    <li key={voter.id} className="flex items-center gap-1.5 text-[11px] text-d-text2">
                      <img src={voter.avatar_url} alt="" className="h-4 w-4 rounded-full object-cover" />
                      {voter.display_name || voter.username}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-d-text3">
        <span className="flex items-center gap-1">
          <Users className="h-3 w-3" aria-hidden="true" />
          {t('poll.voterCount', { count: poll.total_voters })}
        </span>

        {closed ? (
          <span className="flex items-center gap-1 font-semibold text-d-text2">
            <Lock className="h-3 w-3" aria-hidden="true" /> {t('poll.closed')}
          </span>
        ) : remaining ? (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" aria-hidden="true" /> {remaining}
          </span>
        ) : null}

        {!closed && canManage && (
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="ml-auto text-d-text3 hover:text-d-danger hover:underline"
          >
            {t('poll.endNow')}
          </button>
        )}
      </div>

      {closed && (
        <p className="mt-1 text-[11px] text-d-text4">
          {t('poll.finalResult', {
            date: new Date(poll.closed_at).toLocaleString(localeTag(), {
              day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
            })
          })}
        </p>
      )}
    </div>
  );
}
