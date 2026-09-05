// ============================================================================
//  User Settings.
//
//  Discord's settings is not a dialog box floating over the app — it *replaces*
//  the app. That matters for more than looks: a full-bleed surface gives the
//  content column a stable 740px measure at any window size, and the sidebar
//  gets to breathe instead of being squeezed into a card.
//
//  Layout: ONE centred block, not two halves.
//
//      rail colour bleeds left            content colour bleeds right
//     ┌───────────┬───────────────────────────────────────┬───────────┐
//     │           │ ┌────────┬──────────────────────┐      │           │
//     │  #2b2d31  │ │ search │ page title           │ (X)  │  #313338  │
//     │           │ │ GROUP  │ ──────────────────── │ ESC  │           │
//     │           │ │ ▸ tab  │ rows…                │      │           │
//     │           │ └ 240px ─┴──── max 740px ───────┘      │           │
//     └───────────┴───────────────────────────────────────┴───────────┘
//                 └────────── max 1060px, centred ────────┘
//
//  The first version really did use two 50% halves aligned toward the gutter.
//  That only centres when both sides are the same width; ours are 240 and 740,
//  so on a 1919px screen the block sat 261px right of centre with 742px of dead
//  space on the left and 220px on the right. Centring one block and painting
//  the rail/content split with a gradient gives Discord's look and is correct at
//  every width.
//
//  The rail is 240px rather than Discord's 218px because Thai labels are longer.
//  They also wrap instead of truncating: "ความเป็นส่วนตัวและความปลอดภัย" was
//  being cut to "ความเป็นส่วนตัวแล…", which made three of the eleven tabs
//  unreadable.
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import VoiceSettings from './settings/VoiceSettings';
import AccountSecurityTab from './settings/AccountSecurityTab';
import AppearanceTab from './settings/AppearanceTab';
import AccessibilityTab from './settings/AccessibilityTab';
import NotificationsTab from './settings/NotificationsTab';
import KeybindsTab from './settings/KeybindsTab';
import PrivacyTab from './settings/PrivacyTab';
import ApplicationsTab from './settings/ApplicationsTab';
import ChatTab from './settings/ChatTab';
import StreamerModeTab from './settings/StreamerModeTab';
import ActivityTab from './settings/ActivityTab';
import ProfileTab from './settings/ProfileTab';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  X, User, Palette, Volume2, ShieldCheck, Bell, Keyboard, Search,
  Accessibility, MessageSquare, Radio, Activity, Lock, LogOut, Bot
} from 'lucide-react';
import { t } from '../i18n/index.jsx';

const APP_VERSION = import.meta.env?.VITE_APP_VERSION ?? '1.0.0';

/**
 * Two groups, the way Discord splits User Settings from App Settings.
 * `keywords` feeds the search box — people look for "microphone", not "voice".
 */
const tabGroups = () => [
  {
    title: t('settings.groupUser'),
    tabs: [
      { key: 'profile',  icon: User,        label: t('settings.profileTab'),  keywords: t('settings.kwProfile') },
      { key: 'account',  icon: ShieldCheck, label: t('settings.accountTab'),  keywords: t('settings.kwAccount') },
      { key: 'privacy',  icon: Lock,        label: t('settings.privacyTab'),  keywords: t('settings.kwPrivacy') },
      { key: 'activity', icon: Activity,    label: t('settings.activityTab'), keywords: t('settings.kwActivity') }
    ]
  },
  {
    title: t('settings.groupApp'),
    tabs: [
      { key: 'appearance',    icon: Palette,       label: t('settings.appearanceTab'),    keywords: t('settings.kwAppearance') },
      { key: 'accessibility', icon: Accessibility, label: t('settings.accessibilityTab'), keywords: t('settings.kwAccessibility') },
      { key: 'voice',         icon: Volume2,       label: t('settings.voiceTab'),         keywords: t('settings.kwVoice') },
      { key: 'notifications', icon: Bell,          label: t('settings.notificationsTab'), keywords: t('settings.kwNotifications') },
      { key: 'keybinds',      icon: Keyboard,      label: t('settings.keybindsTab'),      keywords: t('settings.kwKeybinds') },
      { key: 'chat',          icon: MessageSquare, label: t('settings.chatTab'),          keywords: t('settings.kwChat') },
      { key: 'streamer',      icon: Radio,         label: t('settings.streamerTab'),      keywords: t('settings.kwStreamer') }
    ]
  },
  {
    title: t('settings.groupDeveloper'),
    tabs: [
      { key: 'developer', icon: Bot, label: t('settings.developerTab'), keywords: t('settings.kwDeveloper') }
    ]
  }
];

const matches = (tab, query) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${tab.label} ${tab.keywords ?? ''}`.toLowerCase().includes(needle);
};

export default function UserSettingsModal({
  currentUser, servers = [], initialTab = 'profile', onClose, onSaveProfile, onSetStatus, onSignOut, onToast
}) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [query, setQuery] = useState('');
  const dialogRef = useFocusTrap(true, onClose);
  const navRef = useRef(null);

  const groups = useMemo(() => {
    return tabGroups()
      .map((group) => ({ ...group, tabs: group.tabs.filter((tab) => matches(tab, query)) }))
      .filter((group) => group.tabs.length > 0);
  }, [query]);

  const visible = groups.flatMap((group) => group.tabs);

  // Searching should land you somewhere useful, not on a page the filter has
  // hidden — so follow the first result once the current tab drops out.
  useEffect(() => {
    if (!query.trim() || visible.length === 0) return;
    if (!visible.some((tab) => tab.key === activeTab)) setActiveTab(visible[0].key);
  }, [query, visible, activeTab]);

  /** ↑/↓ walk the nav, the way Discord's settings sidebar does. */
  const onNavKeyDown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = visible.findIndex((tab) => tab.key === activeTab);
    const next = event.key === 'ArrowDown'
      ? Math.min(index + 1, visible.length - 1)
      : Math.max(index - 1, 0);
    const target = visible[next];
    if (!target) return;
    setActiveTab(target.key);
    navRef.current?.querySelector(`[data-tab="${target.key}"]`)?.focus();
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('sidebar.userSettings')}
      className="settings-surface fixed inset-0 z-50 flex justify-center
        animate-[settingsIn_140ms_ease-out]"
    >
      {/* One centred block, rather than two equal halves pulling apart.
          Two 50% halves aligned toward the gutter only look centred when both
          sides are the same width — ours are 240 and 740, which pushed the whole
          thing 261px right of centre on a 1919px screen and left a 742px gap on
          the left. The sidebar colour still bleeds to the window edge; that is
          painted by the gradient on `.settings-surface`. */}
      <div className="flex w-full max-w-[var(--settings-max)]">
        <div className="w-[var(--settings-rail)] shrink-0 overflow-y-auto overscroll-contain">
        <div className="py-15 pr-2 pl-5 flex flex-col min-h-full">
          <div className="relative mb-4">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-d-text3"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('settings.searchPlaceholder')}
              aria-label={t('settings.searchPlaceholder')}
              className="w-full rounded bg-d-sunken py-1.5 pl-8 pr-2 text-sm text-d-strong
                placeholder:text-d-text3 border border-transparent focus:outline-none
                focus:border-d-brand transition-colors"
            />
          </div>

          <nav ref={navRef} onKeyDown={onNavKeyDown} aria-label={t('settings.userSettings')} className="flex-1">
            {groups.map((group, index) => (
              <div key={group.title} className={index > 0 ? 'mt-4' : undefined}>
                {index > 0 && <div className="mb-4 h-px bg-d-divider" />}
                <h3 className="mb-1 px-2.5 text-xs font-bold uppercase tracking-[0.02em] text-d-text2">
                  {group.title}
                </h3>
                {group.tabs.map((tab) => (
                  <button
                    key={tab.key}
                    data-tab={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    aria-current={activeTab === tab.key ? 'page' : undefined}
                    className={`mb-0.5 flex w-full items-start gap-3 rounded px-2.5 py-1.5 text-left
                      text-base font-medium transition-colors focus:outline-none
                      focus-visible:ring-2 focus-visible:ring-d-brand ${
                        activeTab === tab.key
                          ? 'bg-d-active text-d-strong'
                          : 'text-d-text2 hover:bg-d-hover/60 hover:text-d-strong'
                      }`}
                  >
                    <tab.icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="leading-snug">{tab.label}</span>
                  </button>
                ))}
              </div>
            ))}

            {visible.length === 0 && (
              <p className="px-2.5 py-4 text-sm text-d-text3">
                {t('settings.noSearchResults', { query: query.trim() })}
              </p>
            )}

            <div className="my-4 h-px bg-d-divider" />
            <button
              onClick={onSignOut}
              className="flex w-full items-center gap-3 rounded px-2.5 py-1.5 text-base font-medium
                text-d-text2 transition-colors hover:bg-d-danger hover:text-white"
            >
              <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t('auth.signOut')}
            </button>
          </nav>

          <p className="mt-6 px-2.5 pb-4 text-[11px] text-d-text4">
            {t('settings.version', { version: APP_VERSION })}
          </p>
        </div>
      </div>

      {/* --- content ---------------------------------------------------------- */}
      <div className="relative flex flex-1 min-w-0 justify-start overflow-y-auto overscroll-contain">
        <div className="w-full max-w-[740px] min-w-0 py-15 pl-10 pr-2">
          {activeTab === 'profile' && (
            <ProfileTab
              currentUser={currentUser}
              onSaveProfile={onSaveProfile}
              onSetStatus={onSetStatus}
              onToast={onToast}
            />
          )}
          {activeTab === 'account' && (
            <AccountSecurityTab currentUser={currentUser} onToast={onToast} onSignOut={onSignOut} />
          )}
          {activeTab === 'privacy' && <PrivacyTab currentUser={currentUser} onSaveProfile={onSaveProfile} />}
          {activeTab === 'developer' && <ApplicationsTab servers={servers} onToast={onToast} />}
          {activeTab === 'activity' && <ActivityTab currentUser={currentUser} onSetStatus={onSetStatus} />}
          {activeTab === 'appearance' && <AppearanceTab />}
          {activeTab === 'accessibility' && <AccessibilityTab onToast={onToast} />}
          {activeTab === 'voice' && <VoiceSettings onToast={onToast} />}
          {activeTab === 'notifications' && <NotificationsTab onToast={onToast} />}
          {activeTab === 'keybinds' && <KeybindsTab onToast={onToast} />}
          {activeTab === 'chat' && <ChatTab />}
          {activeTab === 'streamer' && <StreamerModeTab />}
        </div>

        {/* Discord's close affordance: outlined circle with ESC written under it. */}
        <div className="sticky top-15 shrink-0 pr-6 pl-2 hidden md:block">
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="group flex w-9 flex-col items-center gap-1"
          >
            <span
              className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-d-text3
                text-d-text3 transition-colors group-hover:border-d-strong group-hover:bg-d-hover
                group-hover:text-d-strong"
            >
              <X className="h-4 w-4" strokeWidth={2.5} />
            </span>
            <span className="text-[11px] font-bold text-d-text3 transition-colors group-hover:text-d-strong">
              ESC
            </span>
          </button>
        </div>

        {/* Narrow windows lose the gutter, so the close button moves inline. */}
        <button
          onClick={onClose}
          aria-label={t('common.close')}
          className="absolute right-4 top-4 rounded-full p-2 text-d-text2 hover:bg-d-hover
            hover:text-d-strong md:hidden"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      </div>
    </div>
  );
}
