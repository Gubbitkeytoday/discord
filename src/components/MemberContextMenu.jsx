import React from 'react';
import {
  User, MessageSquare, UserPlus, UserMinus, Ban, Shield, Pencil, Clock,
  LogOut, Copy, ShieldAlert, ShieldOff
} from 'lucide-react';
import ContextMenu from './ContextMenu';
import { getPreferences } from '../hooks/useUserSettings';
import { t } from '../i18n/index.jsx';

const TIMEOUT_OPTIONS = () => [
  { minutes: 60,     label: t('members.timeout60m') },
  { minutes: 5,      label: t('members.timeout5m') },
  { minutes: 10,     label: t('members.timeout10m') },
  { minutes: 1440,   label: t('members.timeout1d') },
  { minutes: 10080,  label: t('members.timeout1w') }
];

/**
 * Right-click a member — the same action set Discord offers, with every entry
 * gated by a real permission check rather than being greyed out.
 */
export default function MemberContextMenu({
  user, x, y, currentUser, isGuild, server, roles = [], members = [], friends = [], blocked = [],
  can, onClose, onProfile, onMessage, onAddFriend, onRemoveFriend, onBlock, onUnblock,
  onChangeNickname, onToggleRole, onTimeout, onRemoveTimeout, onKick, onBan, onToast
}) {
  const isSelf = user.id === currentUser?.id;
  const isOwnerTarget = server?.owner_id === user.id;
  const friend = friends.find((f) => f.id === user.id);
  const isBlocked = blocked.some((b) => b.id === user.id);
  const member = members.find((m) => m.id === user.id);
  const memberRoleIds = new Set((member?.roles ?? []).map((r) => r.id));
  const timedOut = member?.timeout_until && member.timeout_until > new Date().toISOString();

  // Discord never lets you moderate the owner, and never yourself.
  const canModerate = isGuild && !isSelf && !isOwnerTarget;
  // @everyone is not assignable; its id equals the server id by convention.
  const assignableRoles = roles.filter((r) => r.id !== server?.id && !r.managed);

  const items = [
    { icon: User, label: t('members.viewProfile'), action: () => onProfile(user) },
    !isSelf && { icon: MessageSquare, label: t('dm.message'), action: () => onMessage(user) },
    !isSelf && !friend && !isBlocked && { icon: UserPlus, label: t('dm.addFriend'), action: () => onAddFriend(user) },
    !isSelf && friend?.friend_status === 'accepted' && {
      icon: UserMinus, label: t('dm.removeFriend'), danger: true, action: () => onRemoveFriend(user)
    },
    !isSelf && (isBlocked
      ? { icon: ShieldOff, label: t('dm.unblock'), action: () => onUnblock(user) }
      : { icon: ShieldAlert, label: t('dm.block'), danger: true, action: () => onBlock(user) }),

    canModerate && can('MANAGE_NICKNAMES') && { separator: true },
    ((isGuild && isSelf && can('CHANGE_NICKNAME')) || (canModerate && can('MANAGE_NICKNAMES'))) && {
      icon: Pencil, label: t('members.changeNickname'), action: () => onChangeNickname(member ?? user)
    },
    isGuild && can('MANAGE_ROLES') && !isOwnerTarget && {
      icon: Shield,
      label: t('members.roles'),
      submenu: assignableRoles.map((role) => ({
        label: role.name,
        checked: memberRoleIds.has(role.id),
        keepOpen: true,
        action: () => onToggleRole(user, role, !memberRoleIds.has(role.id))
      })),
      emptyLabel: t('members.noAssignableRoles')
    },

    canModerate && (can('MODERATE_MEMBERS') || can('KICK_MEMBERS') || can('BAN_MEMBERS')) && { separator: true },
    canModerate && can('MODERATE_MEMBERS') && (timedOut
      ? { icon: Clock, label: t('members.removeTimeout'), action: () => onRemoveTimeout(user) }
      : {
          icon: Clock,
          label: t('members.timeout'),
          submenu: TIMEOUT_OPTIONS().map((option) => ({
            label: option.label,
            action: () => onTimeout(user, option.minutes)
          }))
        }),
    canModerate && can('KICK_MEMBERS') && { icon: LogOut, label: t('members.kick'), danger: true, action: () => onKick(user) },
    canModerate && can('BAN_MEMBERS') && { icon: Ban, label: t('members.ban'), danger: true, action: () => onBan(user) },

    getPreferences().chat.developerMode && { separator: true },
    getPreferences().chat.developerMode && {
      icon: Copy,
      label: t('members.copyUserId'),
      action: () => {
        navigator.clipboard?.writeText(user.id);
        onToast?.(t('common.copied'), { type: 'success', ttl: 2000 });
      }
    }
  ];

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
