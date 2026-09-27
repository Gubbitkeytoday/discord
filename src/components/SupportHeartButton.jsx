import React from 'react';
import { Heart } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import { usePaymentsConfig } from '../payments/usePaymentsConfig.js';

/**
 * The small heart in the user panel that opens Settings › Support. Renders
 * nothing unless this instance takes donations.
 */
export default function SupportHeartButton({ onOpen }) {
  const config = usePaymentsConfig();
  if (!config?.enabled || !onOpen) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('payments.heart')}
      title={t('payments.heart')}
      className="p-1.5 rounded transition-colors hover:bg-d-hover hover:text-[#db2777]"
    >
      <Heart className="w-[18px] h-[18px]" aria-hidden="true" />
    </button>
  );
}
