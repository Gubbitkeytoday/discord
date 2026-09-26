import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { get } from '../../api';
import { localeTag, t } from '../../i18n/index.jsx';
import { reasonLabel } from './safety';

const STATUS_STYLE = {
  open: 'bg-d-idle/15 text-d-text',
  reviewing: 'bg-d-brand/15 text-d-text',
  resolved: 'bg-d-online/15 text-d-text',
  dismissed: 'bg-d-surface text-d-text2'
};

/**
 * "My reports": what you reported, why, and where it stands — so a report is
 * not a message into the void. Who handled it is deliberately not shown.
 */
export default function MyReports() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    get('/api/reports/mine')
      .then((data) => { if (live) setRows(Array.isArray(data) ? data : []); })
      .catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, []);

  if (error) return <p className="text-sm text-d-danger" role="alert">{error}</p>;
  if (!rows) {
    return (
      <p className="flex items-center gap-2 text-sm text-d-text3" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t('common.loading')}
      </p>
    );
  }
  if (rows.length === 0) return <p className="text-sm text-d-text3">{t('safety.noReports')}</p>;

  const fmt = (iso) => {
    try { return new Date(iso).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch { return iso; }
  };

  return (
    <ul className="divide-y divide-d-divider rounded-lg border border-d-divider">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-d-strong">
              {r.target_type === 'user' ? t('safety.reportedUser', { name: r.target_display || r.target_username || '?' })
                : t('safety.reportedMessage', { name: r.target_display || r.target_username || '?' })}
            </span>
            <span className="block text-xs text-d-text2">
              {reasonLabel(r.reason)} · {fmt(r.created_at)}
              {r.server_name ? ` · ${r.server_name}` : ` · ${t('safety.sentToAdmins')}`}
            </span>
          </span>
          <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[r.status] ?? STATUS_STYLE.open}`}>
            {t(`safety.status.${r.status}`)}
          </span>
        </li>
      ))}
    </ul>
  );
}
