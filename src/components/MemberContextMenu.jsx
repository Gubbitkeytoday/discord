import React, { useState } from 'react';
import {
  User, MessageSquare, UserPlus, UserMinus, Ban, Shield, Pencil, Clock,
  LogOut, Copy, ShieldAlert, ShieldOff, Eraser
} from 'lucide-react';
import ContextMenu from './ContextMenu';
import ModerationDialog, { TIMEOUT_OPTIONS } from './admin/ModerationDialog';
import { getPreferences } from '../hooks/useUserSettings';
import { t } from '../i18n/index.jsx';

/**
 * Right-click a member — the same action set Discord offers, with every entry
 * gated by a real permission check rather than being greyed out.
 */
export default function MemberContextMenu({
  user, x, y, currentUser, isGuild, server, roles = [], members = [], friends = [], blocked = [],
  can, onClose, onProfile, onMessage, onAddFriend, onRemoveFriend, onBlock, onUnblock,
  onChangeNickname, onToggleRole, onTimeout, onRemoveTimeout, onKick, onBan, onResetProfile, onToast
}) {
  // Ban opens Discord's full dialog (reason + "delete message history")
  // right here, in place of the menu, instead of a bare confirm.
  const [banning, setBanning] = useState(false);
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
    // Clears their collectibles here and hides their worn tag (audit-logged);
    // the same permission as renaming them.
    canModerate && can('MANAGE_NICKNAMES') && onResetProfile && {
      icon: Eraser, label: t('profiles.resetMenu'), action: () => onResetProfile(member ?? user)
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
    canModerate && can('BAN_MEMBERS') && { icon: Ban, label: t('members.ban'), danger: true, keepOpen: true, action: () => setBanning(true) },

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

  if (banning && server?.id) {
    const name = member?.nickname || member?.display_name || user.display_name || user.username;
    return (
      <ModerationDialog
        kind="ban"
        serverId={server.id}
        targets={[{ id: user.id, name }]}
        onDone={({ done }) => { if (done.length) onToast?.(t('members.banned', { name }), { type: 'success', ttl: 3000 }); }}
        onClose={onClose}
      />
    );
  }

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
