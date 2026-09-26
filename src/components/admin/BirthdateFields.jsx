import React, { useId, useMemo } from 'react';
import { localeTag, t } from '../../i18n/index.jsx';

/**
 * Date of birth as three selects (day / month / year), as Discord asks it.
 * Selects rather than a date input: they work the same on every phone, need
 * no typing, and cannot produce an impossible date. Month names come from the
 * reader's locale.
 *
 * value = { day, month, year } (strings, '' when unset); onChange(next).
 */
export default function BirthdateFields({ value, onChange, required = false, idPrefix, compact = false }) {
  const autoId = useId();
  const base = idPrefix ?? autoId;
  const now = new Date();
  const years = useMemo(() => {
    const top = now.getFullYear();
    return Array.from({ length: 101 }, (_, i) => top - i);
  }, [now.getFullYear()]); // eslint-disable-line react-hooks/exhaustive-deps
  const months = useMemo(() => {
    let fmt;
    try { fmt = new Intl.DateTimeFormat(localeTag(), { month: 'long', timeZone: 'UTC' }); } catch { fmt = null; }
    return Array.from({ length: 12 }, (_, i) => ({
      value: String(i + 1),
      label: fmt ? fmt.format(new Date(Date.UTC(2000, i, 1))) : String(i + 1)
    }));
  }, []);
  const daysInMonth = value.year && value.month
    ? new Date(Date.UTC(Number(value.year), Number(value.month), 0)).getUTCDate()
    : 31;

  const select = `w-full min-h-11 rounded bg-d-base border border-d-edge px-2 text-sm text-d-strong focus:outline-none focus:border-d-brand`;
  const set = (patch) => {
    const next = { ...value, ...patch };
    // A 31st that no longer exists in the chosen month is cleared, not kept.
    const max = next.year && next.month ? new Date(Date.UTC(Number(next.year), Number(next.month), 0)).getUTCDate() : 31;
    if (next.day && Number(next.day) > max) next.day = '';
    onChange(next);
  };

  return (
    <fieldset>
      <legend className={`${compact ? 'mb-1' : 'mb-1.5'} block text-[11px] font-bold uppercase text-d-text2`}>
        {t('safety.dateOfBirth')} {required && <span className="text-d-danger">*</span>}
      </legend>
      <div className="grid grid-cols-[1.4fr_1fr_1.2fr] gap-2">
        <label htmlFor={`${base}-m`} className="sr-only">{t('safety.month')}</label>
        <select id={`${base}-m`} value={value.month} onChange={(e) => set({ month: e.target.value })} required={required} className={select}>
          <option value="">{t('safety.month')}</option>
          {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <label htmlFor={`${base}-d`} className="sr-only">{t('safety.day')}</label>
        <select id={`${base}-d`} value={value.day} onChange={(e) => set({ day: e.target.value })} required={required} className={select}>
          <option value="">{t('safety.day')}</option>
          {Array.from({ length: daysInMonth }, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}</option>)}
        </select>
        <label htmlFor={`${base}-y`} className="sr-only">{t('safety.year')}</label>
        <select id={`${base}-y`} value={value.year} onChange={(e) => set({ year: e.target.value })} required={required} className={select}>
          <option value="">{t('safety.year')}</option>
          {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
        </select>
      </div>
      <p className="mt-1 text-xs text-d-text3 leading-relaxed">{t('safety.dobWhy')}</p>
    </fieldset>
  );
}

/** Age in whole years from { day, month, year } strings, or null. */
export function ageFromFields({ day, month, year }, now = new Date()) {
  if (!day || !month || !year) return null;
  let age = now.getFullYear() - Number(year);
  const m = now.getMonth() + 1;
  if (m < Number(month) || (m === Number(month) && now.getDate() < Number(day))) age -= 1;
  return age;
}
