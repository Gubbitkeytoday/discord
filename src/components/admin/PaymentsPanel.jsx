// Admin console › Payments: every donation order, slips waiting for review
// first, with a slip preview (short-lived signed URL), approve / reject with a
// reason (the payer sees it; both go to the audit log) and running totals.
// The server re-checks instance-admin rights on every call (routes/payments.js).

import React, { useCallback, useEffect, useId, useState } from 'react';
import { Loader2, RefreshCw, CheckCircle2, XCircle, ImageOff, AlertTriangle } from 'lucide-react';
import { get, post } from '../../api';
import { localeTag, t } from '../../i18n/index.jsx';
import { Button, Pill } from '../ui';
import { inputClass } from '../settings/primitives';
import { formatBaht } from '../../payments/usePaymentsConfig.js';

const STATUSES = ['', 'verifying', 'pending', 'paid', 'rejected', 'expired', 'refunded'];
const TONE = { pending: 'neutral', verifying: 'warning', paid: 'success', rejected: 'danger', expired: 'neutral', refunded: 'neutral' };

const fmtDate = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(iso); }
};

export default function PaymentsPanel({ onError, onToast }) {
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const statusId = useId();
  const searchId = useId();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (query.trim()) params.set('q', query.trim());
      setData(await get(`/api/admin/payments?${params}`));
    } catch (err) { onError?.(err); } finally { setBusy(false); }
  }, [status, query, onError]);

  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-d-text3" aria-label={t('common.loading')} /></div>;
  const locale = localeTag();
  const totals = data.totals ?? {};

  return (
    <div className="space-y-4">
      {!data.enabled && (
        <p className="rounded-lg border border-d-divider bg-d-surface px-4 py-3 text-sm text-d-text2">{t('admin.pay.disabled')}</p>
      )}
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['received', formatBaht(totals.paid_satang / 100, locale)],
          ['paidCount', totals.paid_count],
          ['supporters', totals.supporters],
          ['awaiting', totals.awaiting_review]
        ].map(([key, value]) => (
          <div key={key} className="rounded-lg border border-d-divider bg-d-surface px-3 py-2">
            <dt className="text-xs text-d-text3">{t(`admin.pay.${key}`)}</dt>
            <dd className={`text-lg font-bold ${key === 'awaiting' && value > 0 ? 'text-d-idletext' : 'text-d-strong'}`}>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-d-text3">{t('admin.pay.verification', { mode: data.verification })}</p>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); load(); }}
      >
        <div>
          <label htmlFor={statusId} className="mb-1 block text-xs font-medium text-d-text2">{t('admin.pay.filterStatus')}</label>
          <select id={statusId} value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputClass} min-h-10 w-auto py-2`}>
            {STATUSES.map((s) => <option key={s || 'all'} value={s}>{s ? t(`payments.status.${s}`) : t('admin.pay.filterAll')}</option>)}
          </select>
        </div>
        <div className="min-w-[12rem] flex-1">
          <label htmlFor={searchId} className="mb-1 block text-xs font-medium text-d-text2">{t('admin.pay.search')}</label>
          <input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} className={`${inputClass} min-h-10 py-2`} />
        </div>
        <Button type="submit" variant="secondary" disabled={busy} aria-label={t('admin.pay.refresh')}>
          <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" /> {t('admin.pay.refresh')}
        </Button>
      </form>

      {data.orders.length === 0 ? (
        <p className="text-sm text-d-text2">{t('admin.pay.none')}</p>
      ) : (
        <ul className="space-y-2">
          {data.orders.map((o) => (
            <OrderRow key={o.id} order={o} onChanged={load} onError={onError} onToast={onToast} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderRow({ order, onChanged, onError, onToast }) {
  const locale = localeTag();
  const [mode, setMode] = useState(null); // 'approve' | 'reject'
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const actionable = ['pending', 'expired'].includes(order.status) || (order.status === 'rejected' && order.method === 'promptpay');

  const act = async () => {
    setBusy(true);
    try {
      await post(`/api/admin/payments/${order.id}/${mode}`, { reason: reason.trim() || undefined });
      onToast?.(t(mode === 'approve' ? 'admin.pay.approved' : 'admin.pay.rejected'), { type: 'success', ttl: 2500 });
      setMode(null); setReason('');
      onChanged();
    } catch (err) { onError?.(err); } finally { setBusy(false); }
  };

  const check = order.check_code ? t(`payments.check.${order.check_code}`, { amount: formatBaht(order.amount_thb, locale) }) : null;

  return (
    <li className="rounded-lg border border-d-divider bg-d-surface p-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="shrink-0">
          {order.slip_url ? (
            <a href={order.slip_url} target="_blank" rel="noreferrer" className="block">
              <img src={order.slip_url} alt={t('admin.pay.slipOf', { name: order.display_name || order.username || '?' })}
                className="h-40 w-full rounded-md bg-d-sunken object-contain sm:h-32 sm:w-24" loading="lazy" />
            </a>
          ) : (
            <div className="flex h-16 w-full items-center justify-center gap-2 rounded-md bg-d-sunken text-xs text-d-text3 sm:h-32 sm:w-24 sm:flex-col">
              <ImageOff className="h-5 w-5" aria-hidden="true" /> {t('admin.pay.noSlip')}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-bold text-d-strong">{formatBaht(order.amount_thb, locale)}</span>
            <Pill tone={TONE[order.display_status] ?? 'neutral'}>{t(`payments.status.${order.display_status}`)}</Pill>
            <span className="text-xs text-d-text3">{t(`payments.method.${order.method}`)}</span>
          </div>
          <p className="mt-0.5 truncate text-d-text">
            {order.display_name || order.username || '—'}
            {order.username && <span className="text-d-text3"> @{order.username}</span>}
          </p>
          <p className="text-xs text-d-text3">{fmtDate(order.created_at)}{order.paid_at ? ` → ${fmtDate(order.paid_at)}` : ''}</p>
          {order.trans_ref && <p className="break-all text-xs text-d-text3">{t('admin.pay.ref', { ref: order.trans_ref })}</p>}
          {order.paid_amount_satang != null && order.paid_amount_satang !== order.amount_satang && (
            <p className="text-xs text-d-text3">{t('admin.pay.paidAmount', { amount: formatBaht(order.paid_amount_satang / 100, locale) })}</p>
          )}
          {check && <p className="mt-1 text-xs text-d-text2">{t('admin.pay.lastCheck', { reason: check })}</p>}
          {order.duplicate_of && (
            <p className="mt-1 flex items-center gap-1 text-xs font-medium text-d-danger">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> {t('admin.pay.duplicate', { id: order.duplicate_of })}
            </p>
          )}
          {order.note && <p className="mt-1 text-xs text-d-text2">{order.note}</p>}

          {actionable && !mode && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="success" onClick={() => setMode('approve')}>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {t('admin.pay.approve')}
              </Button>
              {order.status !== 'rejected' && (
                <Button size="sm" variant="danger-ghost" onClick={() => setMode('reject')}>
                  <XCircle className="h-4 w-4" aria-hidden="true" /> {t('admin.pay.reject')}
                </Button>
              )}
            </div>
          )}
          {mode && (
            <form className="mt-2 space-y-2" onSubmit={(e) => { e.preventDefault(); act(); }}>
              <label htmlFor={reasonId} className="block text-xs font-medium text-d-text2">
                {mode === 'reject' ? t('admin.pay.reasonLabel') : t('admin.pay.approveNote')}
              </label>
              <input id={reasonId} value={reason} onChange={(e) => setReason(e.target.value.slice(0, 300))}
                required={mode === 'reject'} className={`${inputClass} min-h-10 py-2`} autoFocus />
              <div className="flex gap-2">
                <Button size="sm" type="submit" variant={mode === 'approve' ? 'success' : 'danger'} disabled={busy || (mode === 'reject' && !reason.trim())}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {mode === 'approve' ? t('admin.pay.confirmApprove') : t('admin.pay.confirmReject')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setMode(null); setReason(''); }}>{t('common.cancel')}</Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </li>
  );
}
