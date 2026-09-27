// ============================================================================
//  Settings › Support — donate to the instance.
//
//  Nothing is paywalled. The only thing a payment changes is the cosmetic
//  Supporter badge, which the supporter can hide.
//
//  Flow: amount (preset or custom) → PromptPay QR with the amount, receiver
//  name and an expiry countdown → upload the slip (drop, paste, pick, or the
//  camera on a phone) → live status → thank-you with the badge. Card payment
//  through Stripe when the instance has it. Order history underneath.
//  Live updates arrive as `payments:updated` window events (App.jsx forwards
//  the payment_updated socket event); a slow poll covers a missed event.
// ============================================================================

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Heart, QrCode as QrIcon, Download, Upload, Camera, CreditCard, Loader2, CheckCircle2, XCircle, Clock,
  X, ShieldCheck
} from 'lucide-react';
import { get, post, put, api } from '../../api';
import { t, localeTag, useLocaleCode } from '../../i18n/index.jsx';
import { PageHeader, Section, Note, inputClass, SettingToggle } from './primitives';
import { Button, Pill } from '../ui';
import BadgeRow from '../profile/BadgeRow.jsx';
import QrCode from './QrCode.jsx';
import { usePaymentsConfig, formatBaht, PAYMENT_EVENT } from '../../payments/usePaymentsConfig.js';
import { downloadQrPng, readSlipQr } from '../../payments/qrImage.js';

const STATUS_TONE = {
  pending: 'neutral', verifying: 'warning', paid: 'success', rejected: 'danger', expired: 'neutral', refunded: 'neutral'
};
const SLIP_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const SUPPORTER_BADGE = { id: 'system:supporter', kind: 'system', slug: 'supporter', icon: 'supporter' };

function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const fmtDate = (iso) => {
  try { return new Date(iso).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
};

const fmtDay = (iso) => {
  try { return new Date(iso).toLocaleDateString(localeTag(), { dateStyle: 'long' }); } catch { return iso; }
};

/** A slip that failed an automatic check needs the payer again: show it as waiting. */
const shownStatus = (order) => (order.display_status === 'verifying' && order.check_code && order.check_code !== 'SLIP_REVIEW'
  ? 'pending' : order.display_status);

function StatusPill({ status }) {
  return <Pill tone={STATUS_TONE[status] ?? 'neutral'}>{t(`payments.status.${status}`)}</Pill>;
}

function checkMessage(order) {
  if (!order?.check_code) return null;
  const key = `payments.check.${order.check_code}`;
  const text = t(key, { amount: formatBaht(order.amount_thb, localeTag()) });
  return text === key ? null : text;
}

export default function SupportTab({ onToast }) {
  useLocaleCode();
  const config = usePaymentsConfig();
  const [order, setOrder] = useState(null);
  const [history, setHistory] = useState(null);
  const [supporter, setSupporter] = useState(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await get('/api/payments/orders');
      setHistory(res.orders ?? []);
      return res.orders ?? [];
    } catch { setHistory([]); return []; }
  }, []);
  const loadSupporter = useCallback(() => get('/api/payments/supporter').then(setSupporter).catch(() => {}), []);

  useEffect(() => {
    if (!config?.enabled) return;
    loadSupporter();
    // Resume an open PromptPay order (e.g. after closing settings to go pay).
    loadHistory().then((rows) => {
      const open = rows.find((o) => o.method === 'promptpay'
        && (o.display_status === 'verifying' || (o.status === 'pending' && Date.parse(o.expires_at) > Date.now())));
      if (open) setOrder((cur) => cur ?? open);
    });
  }, [config?.enabled, loadHistory, loadSupporter]);

  // Live updates for the order on screen.
  useEffect(() => {
    const onEvent = (e) => {
      const next = e.detail?.order;
      if (!next) return;
      setOrder((cur) => (cur && cur.id === next.id ? { ...cur, ...next } : cur));
      loadHistory();
      if (next.status === 'paid') loadSupporter();
    };
    window.addEventListener(PAYMENT_EVENT, onEvent);
    return () => window.removeEventListener(PAYMENT_EVENT, onEvent);
  }, [loadHistory, loadSupporter]);

  // Belt and braces while a slip waits: re-read every 15 s.
  useEffect(() => {
    if (order?.display_status !== 'verifying') return undefined;
    const id = setInterval(() => {
      get(`/api/payments/orders/${order.id}`).then((r) => r?.order && setOrder(r.order)).catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, [order?.id, order?.display_status]);

  if (!config) {
    return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-d-text3" aria-label={t('common.loading')} /></div>;
  }
  if (!config.enabled) {
    return (
      <div>
        <PageHeader title={t('payments.title')} />
        <Note>{t('payments.unavailable')}</Note>
      </div>
    );
  }

  const done = () => { setOrder(null); loadHistory(); };

  return (
    <div>
      <PageHeader title={t('payments.title')} description={t('payments.lead')} />
      {order
        ? <OrderView order={order} config={config} onOrder={setOrder} onDone={done} onToast={onToast} />
        : <ChooseAmount config={config} onOrder={(o) => { setOrder(o); loadHistory(); }} onToast={onToast} />}

      {supporter?.supporter_since && (
        <Section title={t('payments.badgeTitle')}>
          <div className="mb-2 flex items-center gap-3 text-sm text-d-text2">
            <BadgeRow badges={[{ ...SUPPORTER_BADGE, granted_at: supporter.supporter_since }]} size={28} />
            <span>{t('payments.supporterSince', { date: fmtDay(supporter.supporter_since) })}</span>
          </div>
          <SettingToggle
            label={t('payments.showBadge')}
            hint={t('payments.showBadgeHint')}
            checked={!supporter.badge_hidden}
            onChange={async (show) => {
              try { setSupporter(await put('/api/payments/supporter', { badge_hidden: !show })); } catch (err) { onToast?.(err.message, { type: 'error' }); }
            }}
            last
          />
        </Section>
      )}

      <History rows={history} onOpen={(o) => o.method === 'promptpay' && setOrder(o)} />
    </div>
  );
}

// --- step 1: amount --------------------------------------------------------------------

function ChooseAmount({ config, onOrder, onToast }) {
  const locale = localeTag();
  const [preset, setPreset] = useState(config.presets[1] ?? config.presets[0] ?? null);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(null);
  const customId = useId();
  const hintId = useId();
  const errorId = useId();

  const customValue = custom.trim() === '' ? null : Number(custom);
  const amount = customValue ?? preset;
  const invalid = customValue !== null
    && (!Number.isInteger(customValue) || customValue < config.min_thb || customValue > config.max_thb);

  const start = async (method) => {
    if (!amount || invalid) return;
    setBusy(method);
    try {
      const res = await post('/api/payments/orders', { amount_thb: amount, method });
      if (method === 'stripe' && res.checkout_url) {
        window.location.assign(res.checkout_url);
        return;
      }
      onOrder(res.order);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const onPresetKey = (e, index) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const next = (index + keys[e.key] + config.presets.length) % config.presets.length;
    setPreset(config.presets[next]); setCustom('');
    e.currentTarget.parentElement?.children[next]?.focus();
  };

  return (
    <Section title={t('payments.chooseAmount')}>
      <div role="radiogroup" aria-label={t('payments.chooseAmount')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {config.presets.map((value, index) => {
          const selected = customValue === null && preset === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (customValue !== null && index === 0) ? 0 : -1}
              onClick={() => { setPreset(value); setCustom(''); }}
              onKeyDown={(e) => onPresetKey(e, index)}
              className={`min-h-12 rounded-lg border-2 px-3 text-lg font-semibold transition-colors ${
                selected ? 'border-d-brand bg-d-brand/10 text-d-strong' : 'border-d-divider bg-d-surface text-d-text hover:border-d-text3'
              }`}
            >
              {formatBaht(value, locale)}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        <label htmlFor={customId} className="mb-1.5 block text-sm font-medium text-d-text2">{t('payments.customAmount')}</label>
        <div className="relative max-w-xs">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-d-text3" aria-hidden="true">฿</span>
          <input
            id={customId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
            aria-describedby={`${hintId}${invalid ? ` ${errorId}` : ''}`}
            aria-invalid={invalid || undefined}
            className={`${inputClass} pl-7`}
            placeholder={String(config.presets[1] ?? 100)}
          />
        </div>
        <p id={hintId} className="mt-1 text-xs text-d-text3">
          {t('payments.customHint', { min: formatBaht(config.min_thb, locale), max: formatBaht(config.max_thb, locale) })}
        </p>
        {invalid && (
          <p id={errorId} className="mt-1 text-xs font-medium text-d-danger" role="alert">
            {t('payments.customHint', { min: formatBaht(config.min_thb, locale), max: formatBaht(config.max_thb, locale) })}
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {config.methods.promptpay && (
          <div className="flex-1 min-w-[220px]">
            <Button size="lg" block disabled={!amount || invalid || Boolean(busy)} onClick={() => start('promptpay')}>
              {busy === 'promptpay' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <QrIcon className="h-4 w-4" aria-hidden="true" />}
              {t('payments.payWithPromptPay', { amount: amount ? formatBaht(amount, locale) : '' })}
            </Button>
            <p className="mt-1.5 text-xs text-d-text3">{t('payments.promptpayHint')}</p>
          </div>
        )}
        {config.methods.stripe && (
          <div className="flex-1 min-w-[220px]">
            <Button size="lg" variant="secondary" block disabled={!amount || invalid || Boolean(busy)} onClick={() => start('stripe')}>
              {busy === 'stripe' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CreditCard className="h-4 w-4" aria-hidden="true" />}
              {t('payments.payWithCard')}
            </Button>
            <p className="mt-1.5 text-xs text-d-text3">{t('payments.cardHint')}</p>
          </div>
        )}
      </div>
      <p className="mt-4 flex items-start gap-2 text-xs text-d-text3">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t('payments.nothingLocked')}
      </p>
    </Section>
  );
}

// --- step 2–4: pay, slip, status --------------------------------------------------------

function OrderView({ order, config, onOrder, onDone, onToast }) {
  const locale = localeTag();
  const status = order.display_status;
  // A failed automatic check may be retried with another slip; a slip that
  // waits for an admin may not.
  const open = status === 'pending' || status === 'expired'
    || (status === 'verifying' && order.check_code && order.check_code !== 'SLIP_REVIEW');
  const now = useNow(status === 'pending');
  const left = Date.parse(order.expires_at) - now;
  const expired = status === 'expired' || (status === 'pending' && left <= 0);
  const amountText = formatBaht(order.amount_thb, locale);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState(null);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [coarse] = useState(() => {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
  });
  const liveId = useId();

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const send = useCallback(async (file) => {
    if (!file || sending) return;
    if (!SLIP_TYPES.includes(file.type)) { onToast?.(t('payments.slipWrongType'), { type: 'error' }); return; }
    if (file.size > config.slip_max_bytes) { onToast?.(t('payments.slipTooLarge'), { type: 'error' }); return; }
    setPreview((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file); });
    setSending(true);
    try {
      const form = new FormData();
      form.append('slip', file);
      const payload = await readSlipQr(file);
      if (payload) form.append('payload', payload);
      const res = await api(`/api/payments/orders/${order.id}/slip`, { method: 'POST', body: form });
      onOrder(res.order);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setSending(false);
    }
  }, [order.id, sending, config.slip_max_bytes, onOrder, onToast]);

  // Paste a screenshot of the slip anywhere on the page.
  useEffect(() => {
    if (!open) return undefined;
    const onPaste = (e) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file) { e.preventDefault(); send(file); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open, send]);

  if (status === 'paid') {
    return (
      <Section>
        <div className="rounded-xl border border-d-divider bg-d-surface p-6 text-center" role="status">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-[color-mix(in_srgb,#db2777_15%,transparent)] text-[#db2777]
            motion-safe:animate-[settingsIn_300ms_ease-out]">
            <Heart className="h-7 w-7" fill="currentColor" aria-hidden="true" />
          </div>
          <h3 className="text-lg font-bold text-d-strong">{t('payments.thanksTitle')}</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-d-text2">{t('payments.thanksBody', { amount: amountText })}</p>
          <div className="mt-4 flex justify-center"><BadgeRow badges={[SUPPORTER_BADGE]} size={32} /></div>
          <Button className="mt-5" variant="secondary" onClick={onDone}>{t('payments.done')}</Button>
        </div>
      </Section>
    );
  }

  const reason = order.reason;
  const check = checkMessage(order);

  return (
    <Section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          <X className="h-4 w-4" aria-hidden="true" /> {t('common.close')}
        </Button>
        <StatusPill status={expired && status === 'pending' ? 'expired' : shownStatus(order)} />
      </div>

      <div id={liveId} role="status" aria-live="polite" className="sr-only">
        {t(`payments.status.${status}`)}{check ? `. ${check}` : ''}{reason ? `. ${t('payments.rejectedReason', { reason })}` : ''}
      </div>

      {(status === 'rejected' || status === 'refunded') && (
        <Note tone="danger">
          <span className="flex items-start gap-2">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-d-danger" aria-hidden="true" />
            <span>
              <strong className="block text-d-strong">{t(`payments.status.${status}`)}</strong>
              {reason && t('payments.rejectedReason', { reason })}
            </span>
          </span>
        </Note>
      )}

      {status === 'verifying' && !order.check_code && (
        <Note tone="warn">
          <span className="flex items-start gap-2">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              <strong className="block text-d-strong">{t('payments.status.verifying')}</strong>
              {t('payments.verifyingManual')}
            </span>
          </span>
        </Note>
      )}
      {check && order.check_code === 'SLIP_REVIEW' && (
        <Note tone="warn">
          <strong className="block text-d-strong">{t('payments.status.verifying')}</strong>
          {check}
        </Note>
      )}
      {check && order.check_code !== 'SLIP_REVIEW' && status !== 'rejected' && (
        <Note tone="danger">
          <strong className="block text-d-strong">{t('payments.slipProblem')}</strong>
          {check} {t('payments.tryAnotherSlip')}
        </Note>
      )}

      {order.method === 'promptpay' && order.qr_payload && status !== 'rejected' && (
        <div className="mt-4 grid gap-5 md:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-center rounded-xl border border-d-divider bg-d-surface p-4">
            <div className="rounded-lg bg-white p-2 pb-1 text-center">
              <div className="mb-1 rounded bg-[#113566] px-2 py-1 text-xs font-bold tracking-wide text-white" lang="th">PromptPay · พร้อมเพย์</div>
              <div className={expired ? 'opacity-30' : ''}>
                <QrCode value={order.qr_payload} size={200} label={t('payments.qrLabel', { amount: amountText })} />
              </div>
            </div>
            <p className="mt-3 text-2xl font-bold text-d-strong">{amountText}</p>
            {order.receiver_name && <p className="text-sm text-d-text">{t('payments.receiver', { name: order.receiver_name })}</p>}
            {order.receiver_hint && <p className="text-xs text-d-text3">{t('payments.receiverId', { hint: order.receiver_hint })}</p>}
            <p className={`mt-2 flex items-center gap-1.5 text-sm tabular-nums ${expired ? 'text-d-danger' : 'text-d-text2'}`}>
              <Clock className="h-4 w-4" aria-hidden="true" />
              {expired ? t('payments.qrExpired') : t('payments.expiresIn', { time: mmss(left) })}
            </p>
            <Button
              className="mt-3"
              variant="secondary"
              size="sm"
              onClick={() => downloadQrPng(order.qr_payload, {
                amountText, caption: order.receiver_name ?? '', filename: `promptpay-${order.amount_thb}.png`
              }).catch(() => onToast?.(t('payments.saveFailed'), { type: 'error' }))}
            >
              <Download className="h-4 w-4" aria-hidden="true" /> {t('payments.saveQr')}
            </Button>
          </div>

          <div className="min-w-0">
            <h4 className="mb-2 text-sm font-semibold text-d-strong">{t('payments.stepsTitle')}</h4>
            <ol className="mb-4 list-decimal space-y-1.5 pl-5 text-sm text-d-text2 marker:text-d-text3">
              <li>{t('payments.step1')}</li>
              <li>{t('payments.step2')}</li>
              <li>{t('payments.step3', { amount: amountText })}</li>
              <li>{t('payments.step4')}</li>
            </ol>
            {expired && <p className="mb-3 text-xs text-d-text3">{t('payments.expiredHint')}</p>}

            {open && (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); send(e.dataTransfer.files?.[0]); }}
                className={`rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
                  dragging ? 'border-d-brand bg-d-brand/10' : 'border-d-divider bg-d-sunken'
                }`}
              >
                {preview && (
                  <img src={preview} alt={t('payments.slipPreview')} className="mx-auto mb-3 max-h-40 rounded-md object-contain" />
                )}
                {sending ? (
                  <p className="flex items-center justify-center gap-2 py-3 text-sm text-d-text2">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t('payments.sending')}
                  </p>
                ) : (
                  <>
                    <Upload className="mx-auto mb-2 h-6 w-6 text-d-text3" aria-hidden="true" />
                    <p className="text-sm font-medium text-d-strong">{order.has_slip ? t('payments.uploadAnother') : t('payments.uploadTitle')}</p>
                    <p className="mb-3 text-xs text-d-text3">{t('payments.dropHint')}</p>
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button size="md" onClick={() => fileRef.current?.click()}>
                        <Upload className="h-4 w-4" aria-hidden="true" /> {t('payments.chooseFile')}
                      </Button>
                      {coarse && (
                        <Button size="md" variant="secondary" onClick={() => cameraRef.current?.click()}>
                          <Camera className="h-4 w-4" aria-hidden="true" /> {t('payments.takePhoto')}
                        </Button>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-d-text3">
                      {t('payments.slipTypes', { size: `${Math.round(config.slip_max_bytes / 1048576)} MB` })}
                    </p>
                  </>
                )}
                <input ref={fileRef} type="file" accept={SLIP_TYPES.join(',')} className="hidden" tabIndex={-1}
                  aria-label={t('payments.chooseFile')}
                  onChange={(e) => { send(e.target.files?.[0]); e.target.value = ''; }} />
                <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" tabIndex={-1}
                  aria-label={t('payments.takePhoto')}
                  onChange={(e) => { send(e.target.files?.[0]); e.target.value = ''; }} />
              </div>
            )}
            {status === 'verifying' && !order.check_code && (
              <p className="mt-3 flex items-center gap-2 text-sm text-d-text2">
                <CheckCircle2 className="h-4 w-4 text-d-success" aria-hidden="true" /> {t('payments.slipReceived')}
              </p>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

// --- history -----------------------------------------------------------------------------

function History({ rows, onOpen }) {
  const locale = localeTag();
  if (!rows) return null;
  return (
    <Section title={t('payments.history')}>
      {rows.length === 0 ? (
        <p className="text-sm text-d-text3">{t('payments.noHistory')}</p>
      ) : (
        <ul className="divide-y divide-d-divider rounded-lg border border-d-divider">
          {rows.map((o) => {
            const openable = o.method === 'promptpay' && o.status !== 'paid' && o.status !== 'refunded';
            const body = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-d-strong">{formatBaht(o.amount_thb, locale)}
                    <span className="ml-2 text-xs font-normal text-d-text3">{t(`payments.method.${o.method}`)}</span>
                  </span>
                  <span className="block text-xs text-d-text3">{fmtDate(o.paid_at ?? o.created_at)}</span>
                  {o.reason && <span className="block text-xs text-d-danger">{o.reason}</span>}
                </span>
                <StatusPill status={shownStatus(o)} />
              </>
            );
            return (
              <li key={o.id}>
                {openable ? (
                  <button type="button" onClick={() => onOpen(o)}
                    className="flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-d-hover">
                    {body}
                  </button>
                ) : (
                  <div className="flex min-h-12 items-center gap-3 px-3 py-2 text-sm">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
