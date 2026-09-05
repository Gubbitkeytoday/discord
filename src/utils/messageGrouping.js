import { t, localeTag } from '../i18n/index.jsx';
// Message list presentation rules, mirroring Discord's behaviour.

/** Two messages group together if same author, same day, within this window. */
const GROUP_WINDOW_MS = 7 * 60 * 1000;

const startOfDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * Annotate each message with what the renderer needs:
 *   isGrouped     → hide avatar and username, show timestamp on hover only
 *   dateDivider   → render a date separator above this message
 *   isFirstUnread → render the red "New messages" bar above this message
 *
 * A message never groups when it is a reply, a system message, or the first
 * message after a divider — Discord always shows a full header in those cases.
 */
export function decorateMessages(messages, { lastReadMessageId = null, currentUserId = null } = {}) {
  let previous = null;
  let unreadMarked = false;

  return messages.map((message) => {
    const created = new Date(message.created_at);
    const previousCreated = previous ? new Date(previous.created_at) : null;

    const isNewDay = !previousCreated || startOfDay(created) !== startOfDay(previousCreated);

    // The unread bar sits above the first message newer than the read marker,
    // and never above your own message — you have read what you just sent.
    const isFirstUnread =
      !unreadMarked &&
      Boolean(lastReadMessageId) &&
      message.id > lastReadMessageId &&
      message.user_id !== currentUserId;
    if (isFirstUnread) unreadMarked = true;

    const isGrouped =
      !isNewDay &&
      !isFirstUnread &&
      !message.reply_to_id &&
      ['default', 'reply'].includes(message.type) && !message.sticker &&
      previous?.type !== 'join' && previous?.type !== 'pin' && previous?.type !== 'thread_created' &&
      previous?.user_id === message.user_id &&
      created - previousCreated < GROUP_WINDOW_MS;

    previous = message;
    return { ...message, isGrouped, dateDivider: isNewDay ? created : null, isFirstUnread };
  });
}

const DAY_MS = 86400000;

/** "Today" / "Yesterday" / "31 กรกฎาคม 2026", matching Discord's divider. */
export function formatDateDivider(date, locale = localeTag()) {
  const today = startOfDay(new Date());
  const target = startOfDay(date);
  if (target === today) return t('chat.today');
  if (target === today - DAY_MS) return t('chat.yesterday');
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatTime(date, locale = localeTag(), use24Hour = true) {
  return new Date(date).toLocaleTimeString(locale, {
    hour: '2-digit', minute: '2-digit', hour12: !use24Hour
  });
}

/** Full timestamp for the hover tooltip on a grouped message. */
export function formatFullTimestamp(date, locale = localeTag()) {
  return new Date(date).toLocaleString(locale, {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

/** "กำลังพิมพ์" text for 1, 2, 3, or many users — same shape as Discord. */
export function formatTypingText(names) {
  if (names.length === 0) return null;
  if (names.length === 1) return t('chat.typingOne', { name: names[0] });
  if (names.length === 2) return t('chat.typingTwo', { first: names[0], second: names[1] });
  if (names.length === 3) return t('chat.typingThree', { first: names[0], second: names[1], third: names[2] });
  return t('chat.typingMany');
}

/** Compact "5m" / "3h" / "2d" stamp for the notification inbox. */
export function formatRelativeShort(date) {
  const diff = Date.now() - new Date(date).getTime();
  if (!Number.isFinite(diff)) return '';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('time.now');
  if (minutes < 60) return t('time.minutesShort', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursShort', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('time.daysShort', { count: days });
  return new Date(date).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short' });
}
