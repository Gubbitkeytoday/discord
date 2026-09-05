import React from 'react';
import {
  Reply, Pencil, Trash2, Pin, PinOff, Copy, Link2, SmilePlus, Hash,
  MessagesSquare, Forward, MailOpen, Flag, Megaphone
} from 'lucide-react';
import ContextMenu from './ContextMenu';
import { getPreferences } from '../hooks/useUserSettings';
import { t } from '../i18n/index.jsx';

/**
 * Right-click menu for a message, matching Discord's action set. Destructive
 * and moderator-only entries appear only when the viewer actually holds the
 * permission — `canManage` is resolved from the channel, not assumed.
 */
export default function MessageContextMenu({
  message, x, y, isOwn, canManage, canPin, onClose,
  onReply, onEdit, onDelete, onTogglePin, onAddReaction, onCreateThread,
  onForward, onMarkUnread, onReport, onPublish, onToast
}) {
  const copy = (value) => {
    navigator.clipboard?.writeText(value);
    onToast?.(t('common.copied'), { type: 'success', ttl: 2000 });
  };

  const items = [
    { icon: SmilePlus, label: t('chat.addReaction'), action: () => onAddReaction?.(message) },
    onReply && { icon: Reply, label: t('chat.reply'), action: () => onReply(message) },
    onForward && { icon: Forward, label: t('chat.forward'), action: () => onForward(message) },
    isOwn && { icon: Pencil, label: t('chat.editMessage'), action: () => onEdit?.(message) },
    onCreateThread && { icon: MessagesSquare, label: t('chat.createThread'), action: () => onCreateThread(message) },
    onPublish && !message.crossposted && (isOwn || canManage)
      && { icon: Megaphone, label: t('chat.publish'), action: () => onPublish(message) },
    canPin && {
      icon: message.pinned ? PinOff : Pin,
      label: message.pinned ? t('chat.unpinMessage') : t('chat.pinMessage'),
      action: () => onTogglePin?.(message, !message.pinned)
    },
    onMarkUnread && { icon: MailOpen, label: t('chat.markUnread'), action: () => onMarkUnread(message) },
    { separator: true },
    { icon: Copy, label: t('chat.copyText'), action: () => copy(message.content ?? '') },
    {
      icon: Link2,
      label: t('chat.copyLink'),
      action: () => copy(`${window.location.origin}/channels/${message.server_id ?? '@me'}/${message.channel_id}/${message.id}`)
    },
    getPreferences().chat.developerMode
      && { icon: Hash, label: t('chat.copyId'), action: () => copy(message.id) },
    !isOwn && onReport && { separator: true },
    !isOwn && onReport && { icon: Flag, label: t('chat.reportMessage'), danger: true, action: () => onReport(message) },
    (isOwn || canManage) && { separator: true },
    (isOwn || canManage) && {
      icon: Trash2, label: t('chat.deleteMessage'), danger: true, action: () => onDelete?.(message)
    }
  ];

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
