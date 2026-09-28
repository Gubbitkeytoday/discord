// Payments configuration for the client: fetched once per page load and
// shared by every caller (the user-panel heart, Settings › Support). When the
// instance has not configured payments this resolves to { enabled: false }
// and every payments surface renders nothing.

import { useEffect, useState } from 'react';
import { get } from '../api';

let cached = null;
let inflight = null;

export function loadPaymentsConfig() {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = get('/api/payments/config')
      .then((cfg) => { cached = cfg?.enabled ? cfg : { enabled: false }; return cached; })
      .catch(() => ({ enabled: false }))
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function usePaymentsConfig() {
  const [config, setConfig] = useState(cached);
  useEffect(() => {
    let alive = true;
    if (!cached) loadPaymentsConfig().then((c) => { if (alive) setConfig(c); });
    return () => { alive = false; };
  }, []);
  return config;
}

/** "฿1,234" in the reader's locale. */
export function formatBaht(amount, locale) {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: 'THB', currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `฿${amount}`;
  }
}

/** Live order changes from the socket (App.jsx re-dispatches payment_updated). */
export const PAYMENT_EVENT = 'payments:updated';
