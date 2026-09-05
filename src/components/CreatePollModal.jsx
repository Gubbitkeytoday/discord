// ============================================================================
//  Create a poll.
//
//  Discord's composer: a question, two to ten answers, a duration, and a
//  single-vs-multiple switch. The details that make it feel right:
//
//   - The last empty answer row grows a new one as you type, so you never hunt
//     for an "add" button; the button is still there for keyboard users.
//   - Enter moves to the next answer rather than submitting, because submitting
//     halfway through writing the options is never what you meant.
//   - The limits shown are the server's limits. If they ever disagree, the
//     server wins and says so — but they are stated here so you find out before
//     typing 300 characters.
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, Trash2, Loader2, BarChart3 } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t } from '../i18n/index.jsx';

const LIMITS = { question: 300, answer: 55, maxAnswers: 10, minAnswers: 2 };

const DURATIONS = () => [
  { hours: 1,   label: t('poll.duration1h') },
  { hours: 4,   label: t('poll.duration4h') },
  { hours: 8,   label: t('poll.duration8h') },
  { hours: 24,  label: t('poll.duration1d') },
  { hours: 72,  label: t('poll.duration3d') },
  { hours: 168, label: t('poll.duration7d') },
  { hours: 336, label: t('poll.duration14d') },
  { hours: 0,   label: t('poll.durationNever') }
];

export default function CreatePollModal({ onClose, onCreate, onToast }) {
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState(['', '']);
  const [durationHours, setDurationHours] = useState(24);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialogRef = useFocusTrap(true, onClose);
  const answerRefs = useRef([]);

  const filled = answers.map((a) => a.trim()).filter(Boolean);
  const valid = question.trim().length > 0 && filled.length >= LIMITS.minAnswers;

  // Keep exactly one trailing blank row, up to the cap.
  useEffect(() => {
    const trailingBlank = answers.length > 0 && answers[answers.length - 1].trim() === '';
    if (!trailingBlank && answers.length < LIMITS.maxAnswers) {
      setAnswers((current) => [...current, '']);
    }
  }, [answers]);

  const setAnswer = (index, value) =>
    setAnswers((current) => current.map((a, i) => (i === index ? value : a)));

  const removeAnswer = (index) =>
    setAnswers((current) => {
      const next = current.filter((_, i) => i !== index);
      return next.length >= 2 ? next : [...next, ''];
    });

  const onAnswerKeyDown = (index) => (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();          // never submit from inside the answer list
    answerRefs.current[index + 1]?.focus();
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onCreate({
        question: question.trim(),
        answers: filled,
        durationHours: durationHours || null,
        allowMultiple
      });
      onClose();
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center overlay-center bg-black/70 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('poll.createTitle')}
        className="w-full max-w-lg rounded-xl border border-d-divider bg-d-canvas shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-d-divider px-5 py-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-d-strong">
            <BarChart3 className="h-5 w-5" aria-hidden="true" /> {t('poll.createTitle')}
          </h2>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded p-1.5 text-d-text3 hover:bg-d-hover hover:text-d-strong"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="mb-2 flex items-baseline justify-between text-xs font-bold uppercase
              tracking-wide text-d-text2">
              {t('poll.question')}
              <span className="tabular-nums font-normal text-d-text4">
                {question.length}/{LIMITS.question}
              </span>
            </span>
            <input
              autoFocus
              value={question}
              maxLength={LIMITS.question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={t('poll.questionPlaceholder')}
              className="w-full rounded-lg border border-transparent bg-d-sunken px-3 py-2.5 text-sm
                text-d-strong placeholder:text-d-text4 focus:border-d-brand focus:outline-none"
            />
          </label>

          <div>
            <span className="mb-2 block text-xs font-bold uppercase tracking-wide text-d-text2">
              {t('poll.answers')}
            </span>
            <div className="space-y-2">
              {answers.map((answer, index) => (
                <div key={index} className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-center text-xs tabular-nums text-d-text4">
                    {index + 1}
                  </span>
                  <input
                    ref={(el) => { answerRefs.current[index] = el; }}
                    value={answer}
                    maxLength={LIMITS.answer}
                    onChange={(event) => setAnswer(index, event.target.value)}
                    onKeyDown={onAnswerKeyDown(index)}
                    placeholder={t('poll.answerPlaceholder', { n: index + 1 })}
                    aria-label={t('poll.answerPlaceholder', { n: index + 1 })}
                    className="flex-1 rounded-lg border border-transparent bg-d-sunken px-3 py-2 text-sm
                      text-d-strong placeholder:text-d-text4 focus:border-d-brand focus:outline-none"
                  />
                  <span className="w-8">
                    {answers.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeAnswer(index)}
                        aria-label={t('poll.removeAnswer', { n: index + 1 })}
                        className="rounded p-1.5 text-d-text3 hover:bg-d-hover hover:text-d-danger"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>

            {answers.length < LIMITS.maxAnswers && (
              <button
                type="button"
                onClick={() => setAnswers((current) => [...current, ''])}
                className="mt-2 flex items-center gap-1.5 pl-7 text-sm text-d-text2 hover:text-d-strong"
              >
                <Plus className="h-4 w-4" /> {t('poll.addAnswer')}
              </button>
            )}
            <p className="mt-1 pl-7 text-[11px] text-d-text4">
              {t('poll.answerLimits', { min: LIMITS.minAnswers, max: LIMITS.maxAnswers })}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs font-bold uppercase tracking-wide text-d-text2">
                {t('poll.duration')}
              </span>
              <select
                value={durationHours}
                onChange={(event) => setDurationHours(Number(event.target.value))}
                className="w-full cursor-pointer rounded-lg border border-transparent bg-d-sunken px-3
                  py-2.5 text-sm text-d-strong focus:border-d-brand focus:outline-none"
              >
                {DURATIONS().map((d) => (
                  <option key={d.hours} value={d.hours}>{d.label}</option>
                ))}
              </select>
            </label>

            <div className="flex items-end">
              <label className="flex cursor-pointer items-center gap-3 pb-2.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={allowMultiple}
                  onClick={() => setAllowMultiple((v) => !v)}
                  className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full
                    transition-colors ${allowMultiple ? 'bg-d-success' : 'bg-d-control'}`}
                >
                  <span className={`h-[18px] w-[18px] rounded-full bg-white shadow transition-transform
                    ${allowMultiple ? 'translate-x-[21px]' : 'translate-x-[3px]'}`} />
                </button>
                <span className="text-sm text-d-strong">{t('poll.allowMultiple')}</span>
              </label>
            </div>
          </div>
        </div>

        <footer className="flex justify-end gap-3 border-t border-d-divider px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-d-text2 hover:underline"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={!valid || busy}
            className="flex items-center gap-2 rounded-lg bg-d-brand px-5 py-2 text-sm font-medium
              text-white transition-colors hover:bg-d-brandhover disabled:cursor-not-allowed
              disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('poll.create')}
          </button>
        </footer>
      </div>
    </div>
  );
}
