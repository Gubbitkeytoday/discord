// ============================================================================
//  What a newcomer sees after joining: welcome → rules → questions → done.
//  Steps that the server has not configured are skipped. A pending member
//  cannot dismiss this until the rules are accepted (Discord's gate); a member
//  who is not pending can close it and never sees it again for that server.
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { X, Hash, Volume2, MessagesSquare, Megaphone, Check, Loader2, ShieldCheck, ArrowRight, ArrowLeft } from 'lucide-react';
import { get, put } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t } from '../i18n/index.jsx';

const ICONS = { text: Hash, voice: Volume2, forum: MessagesSquare, announcement: Megaphone, stage: Volume2 };

export default function OnboardingModal({ server, onClose, onComplete, onToast, onSelectChannel }) {
  const [bundle, setBundle] = useState(null);
  const [step, setStep] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const mustStay = Boolean(bundle?.me?.pending);
  const dialogRef = useFocusTrap(true, mustStay ? () => {} : onClose);

  useEffect(() => {
    if (!server?.id) return;
    get(`/api/servers/${server.id}/onboarding`)
      .then((b) => { setBundle(b); setAnswers(b.me?.answers ?? {}); })
      .catch((err) => { onToast?.(err.message, { type: 'error' }); onClose(); });
  }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const steps = useMemo(() => {
    if (!bundle) return [];
    const list = [];
    if (bundle.welcome.enabled && (bundle.welcome.description || bundle.welcome.channels.length)) list.push('welcome');
    if (bundle.screening.enabled && bundle.screening.rules.length) list.push('rules');
    if (bundle.prompts.length) list.push('prompts');
    return list;
  }, [bundle]);

  useEffect(() => { if (bundle && steps.length === 0 && !mustStay) onClose(); }, [bundle, steps.length, mustStay, onClose]);

  const current = steps[step];
  const isLast = step === steps.length - 1;

  const canAdvance = () => {
    if (current === 'rules') return accepted;
    if (current === 'prompts') {
      return bundle.prompts.every((p) => !p.required || (answers[p.id]?.length ?? 0) > 0);
    }
    return true;
  };

  const toggle = (prompt, optionId) => {
    setAnswers((cur) => {
      const had = cur[prompt.id] ?? [];
      if (prompt.single_select) return { ...cur, [prompt.id]: had.includes(optionId) ? [] : [optionId] };
      return { ...cur, [prompt.id]: had.includes(optionId) ? had.filter((x) => x !== optionId) : [...had, optionId] };
    });
  };

  const finish = async () => {
    setBusy(true); setError(null);
    try {
      const result = await put(`/api/servers/${server.id}/onboarding/complete`, {
        accept_rules: accepted || !bundle.screening.enabled, answers
      });
      onComplete?.(result);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!bundle || steps.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[90] bg-black/75 flex items-center justify-center overlay-center p-4" onClick={mustStay ? undefined : onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-d-canvas rounded-xl shadow-2xl border border-d-edge flex flex-col max-h-[calc(100vh-2rem)]"
      >
        <header className="px-6 pt-6 pb-3 text-center relative">
          {!mustStay && (
            <button type="button" onClick={onClose} className="absolute top-4 right-4 text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
              <X className="w-5 h-5" />
            </button>
          )}
          {server.icon_url
            ? <img src={server.icon_url} alt="" className="w-16 h-16 rounded-2xl object-cover mx-auto mb-3" />
            : <div className="w-16 h-16 rounded-2xl bg-d-brand text-white font-bold text-xl flex items-center justify-center mx-auto mb-3">{server.name?.slice(0, 2)}</div>}
          <h2 id="onboarding-title" className="text-xl font-bold text-d-strong">
            {current === 'welcome' && t('onboarding.welcomeTo', { server: server.name })}
            {current === 'rules' && t('onboarding.rulesTitle')}
            {current === 'prompts' && t('onboarding.promptsTitle')}
          </h2>
          {steps.length > 1 && (
            <div className="flex justify-center gap-1.5 mt-3" aria-label={t('onboarding.stepOf', { n: step + 1, total: steps.length })}>
              {steps.map((s, i) => <span key={s} className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-d-brand' : 'w-1.5 bg-d-edge'}`} />)}
            </div>
          )}
        </header>

        <div className="px-6 pb-4 overflow-y-auto">
          {current === 'welcome' && (
            <div>
              {bundle.welcome.description && <p className="text-sm text-d-text2 text-center mb-4">{bundle.welcome.description}</p>}
              <ul className="space-y-2">
                {bundle.welcome.channels.map((c) => {
                  const Icon = ICONS[c.type] ?? Hash;
                  return (
                    <li key={c.channel_id}>
                      <button
                        type="button"
                        onClick={() => { onSelectChannel?.(c.channel_id); if (!mustStay) onClose(); }}
                        className="w-full flex items-center gap-3 bg-d-surface hover:bg-d-surface/70 border border-d-edge rounded-lg px-3 py-2.5 text-left"
                      >
                        <span className="text-xl w-8 text-center" aria-hidden="true">{c.emoji || <Icon className="w-5 h-5 text-d-text4 inline" />}</span>
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-d-strong truncate">#{c.name}</span>
                          <span className="block text-xs text-d-text3 truncate">{c.description}</span>
                        </span>
                        <ArrowRight className="w-4 h-4 text-d-text4 ml-auto shrink-0" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {current === 'rules' && (
            <div>
              <p className="text-sm text-d-text2 text-center mb-4">{t('onboarding.rulesLead')}</p>
              <ol className="space-y-2 mb-4">
                {bundle.screening.rules.map((rule, i) => (
                  <li key={i} className="flex gap-3 bg-d-surface/60 rounded-lg px-3 py-2.5 text-sm">
                    <span className="font-bold text-d-brand shrink-0">{i + 1}.</span>
                    <span className="text-d-strong whitespace-pre-line break-words">{rule}</span>
                  </li>
                ))}
              </ol>
              <label className="flex items-start gap-3 bg-d-surface border border-d-edge rounded-lg px-3 py-3 cursor-pointer">
                <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 w-4 h-4 accent-d-brand" />
                <span className="text-sm text-d-strong">{t('onboarding.iAgree')}</span>
              </label>
            </div>
          )}

          {current === 'prompts' && (
            <div className="space-y-5">
              {bundle.prompts.map((p) => (
                <fieldset key={p.id}>
                  <legend className="font-semibold text-d-strong text-sm mb-0.5">
                    {p.title}{p.required && <span className="text-d-danger"> *</span>}
                  </legend>
                  <p className="text-[11px] text-d-text3 mb-2">{p.single_select ? t('onboarding.pickOne') : t('onboarding.pickAny')}</p>
                  <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                    {p.options.map((o) => {
                      const on = (answers[p.id] ?? []).includes(o.id);
                      return (
                        <label key={o.id} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${on ? 'bg-d-brand/15 border-d-brand' : 'bg-d-surface/60 border-d-edge hover:border-d-text4'}`}>
                          <input type={p.single_select ? 'radio' : 'checkbox'} name={`prompt-${p.id}`} checked={on} onChange={() => toggle(p, o.id)} className="sr-only" />
                          <span className="text-lg leading-none" aria-hidden="true">{o.emoji || '•'}</span>
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold text-d-strong">{o.title}</span>
                            {o.description && <span className="block text-xs text-d-text3">{o.description}</span>}
                          </span>
                          {on && <Check className="w-4 h-4 text-d-brand ml-auto shrink-0 mt-0.5" aria-hidden="true" />}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
          )}

          {error && <p role="alert" className="text-sm text-d-danger mt-3">{error}</p>}
        </div>

        <footer className="flex items-center justify-between gap-3 px-6 py-4 border-t border-d-edge bg-d-surface/40 rounded-b-xl">
          <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
            className="inline-flex items-center gap-1 text-sm text-d-text2 hover:text-d-strong disabled:opacity-0 px-2 py-2">
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />{t('common.back')}
          </button>
          {isLast ? (
            <button type="button" onClick={finish} disabled={busy || !canAdvance()}
              className="inline-flex items-center gap-2 bg-d-brand hover:bg-d-brand-hover disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-md">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="w-4 h-4" aria-hidden="true" />}
              {t('onboarding.finish')}
            </button>
          ) : (
            <button type="button" onClick={() => setStep((s) => s + 1)} disabled={!canAdvance()}
              className="inline-flex items-center gap-2 bg-d-brand hover:bg-d-brand-hover disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-md">
              {t('common.next')}<ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
