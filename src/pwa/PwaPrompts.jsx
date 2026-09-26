import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RefreshCw, Bell, X, Share } from 'lucide-react';
import { I18nProvider, t } from '../i18n/index.jsx';
import { usePwaState } from './store';
import { applyUpdate } from './register';
import { enablePush, pushSupport, getPushConfig } from './push';
import { snoozeNotificationPrompt, dismissNotificationPrompt } from './prompts';
import { requestNotificationPermission } from '../utils/notifier';

/**
 * The PWA's own small surfaces, rendered in a separate root at the bottom of
 * the window: "New version available" and the notifications offer. Both are
 * polite (role="status"), dismissible, and never block the app.
 */
function Banner({ icon, children, actions, onClose, label }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="pointer-events-auto flex max-w-[min(440px,calc(100vw-24px))] items-start gap-3 rounded-lg
        border border-d-divider bg-d-sunken px-4 py-3 text-sm text-d-text shadow-2xl"
    >
      <span className="mt-0.5 shrink-0 text-d-brand" aria-hidden="true">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="leading-snug text-d-strong">{children}</div>
        {actions && <div className="mt-2.5 flex flex-wrap gap-2">{actions}</div>}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="shrink-0 rounded p-1 text-d-text3 hover:bg-d-hover hover:text-d-strong"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

const primary = 'rounded bg-d-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-d-brandhover';
const secondary = 'rounded bg-d-control2 px-3 py-1.5 text-xs font-semibold text-d-strong hover:bg-d-control';

function NotificationOffer() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const support = pushSupport();

  if (support === 'needs-install') {
    return (
      <Banner
        icon={<Share className="h-5 w-5" />}
        label={t('pwa.iosInstallTitle')}
        onClose={snoozeNotificationPrompt}
        actions={<button type="button" className={secondary} onClick={snoozeNotificationPrompt}>{t('pwa.gotIt')}</button>}
      >
        <p className="font-semibold">{t('pwa.iosInstallTitle')}</p>
        <p className="mt-0.5 text-d-text2">{t('pwa.iosInstallBody')}</p>
      </Banner>
    );
  }

  const enable = async () => {
    setBusy(true);
    try {
      const cfg = await getPushConfig();
      if (cfg?.enabled && support === 'supported') {
        const outcome = await enablePush();
        setResult(outcome.ok ? 'on' : outcome.reason === 'denied' ? 'denied' : 'desktop');
      } else {
        const permission = await requestNotificationPermission();
        setResult(permission === 'granted' ? 'desktop' : 'denied');
      }
    } catch {
      setResult('error');
    } finally {
      setBusy(false);
      setTimeout(dismissNotificationPrompt, 3500);
    }
  };

  if (result) {
    const text = {
      on: t('pwa.pushOn'), desktop: t('notif.permissionGranted'),
      denied: t('notif.permissionDenied'), error: t('pwa.pushError')
    }[result];
    return <Banner icon={<Bell className="h-5 w-5" />} label={text} onClose={dismissNotificationPrompt}>{text}</Banner>;
  }

  return (
    <Banner
      icon={<Bell className="h-5 w-5" />}
      label={t('pwa.askTitle')}
      onClose={snoozeNotificationPrompt}
      actions={(
        <>
          <button type="button" className={primary} disabled={busy} onClick={enable}>{t('pwa.enable')}</button>
          <button type="button" className={secondary} onClick={snoozeNotificationPrompt}>{t('pwa.notNow')}</button>
        </>
      )}
    >
      <p className="font-semibold">{t('pwa.askTitle')}</p>
      <p className="mt-0.5 text-d-text2">{t('pwa.askBody')}</p>
    </Banner>
  );
}

function PwaPrompts() {
  const { updateReady, askNotifications, userId } = usePwaState();
  const [updateDismissed, setUpdateDismissed] = useState(false);
  if (!userId && !updateReady) return null;
  return (
    <div className="pointer-events-none fixed bottom-3 left-1/2 z-[80] flex -translate-x-1/2 flex-col items-center gap-2">
      {updateReady && !updateDismissed && (
        <Banner
          icon={<RefreshCw className="h-5 w-5" />}
          label={t('pwa.updateTitle')}
          onClose={() => setUpdateDismissed(true)}
          actions={<button type="button" className={primary} onClick={applyUpdate}>{t('pwa.reload')}</button>}
        >
          {t('pwa.updateTitle')}
        </Banner>
      )}
      {askNotifications && userId && <NotificationOffer />}
    </div>
  );
}

export function mountPwaPrompts(host) {
  createRoot(host).render(<I18nProvider><PwaPrompts /></I18nProvider>);
}
