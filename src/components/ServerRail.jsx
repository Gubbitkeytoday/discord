import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Compass, FolderOpen, Link2 } from 'lucide-react';
import { useUserSettings, getPreferences, updatePreferences } from '../hooks/useUserSettings';
import { t } from '../i18n/index.jsx';
import { serverIconOf, serverInitials } from '../utils/avatar';
import BrandMark from './ui/BrandMark.jsx';
import { MentionBadge } from './ui/Badge.jsx';
import AnimatedServerIcon from './server/AnimatedServerIcon.jsx';
import FolderSettingsPopover from './server/FolderSettingsPopover.jsx';

const FOLDER_COLORS = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f47b67', '#3ba55c', '#faa61a'];

/**
 * Turn the flat server list plus the saved layout into the rail's rows:
 * either `{ kind:'server', server }` or `{ kind:'folder', folder, servers }`.
 * Servers missing from the saved order keep join order at the end; folders
 * that lost all their servers vanish.
 */
function buildRows(servers, layout) {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const folders = (layout?.serverFolders ?? [])
    .map((f) => ({ ...f, servers: f.serverIds.map((id) => byId.get(id)).filter(Boolean) }))
    .filter((f) => f.servers.length > 0);
  const inFolder = new Set(folders.flatMap((f) => f.servers.map((s) => s.id)));
  const order = layout?.serverOrder ?? [];
  const seen = new Set();
  const rows = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    const folder = folders.find((f) => f.id === id);
    if (folder) { rows.push({ kind: 'folder', folder, servers: folder.servers }); seen.add(id); continue; }
    const server = byId.get(id);
    if (server && !inFolder.has(id)) { rows.push({ kind: 'server', server }); seen.add(id); }
  }
  for (const folder of folders) if (!seen.has(folder.id)) { rows.push({ kind: 'folder', folder, servers: folder.servers }); seen.add(folder.id); }
  for (const server of servers) if (!seen.has(server.id) && !inFolder.has(server.id)) rows.push({ kind: 'server', server });
  return rows;
}

// The rail is always mounted while signed in; it records the server list so
// the server context menu can reorder without being handed it.
let lastServers = [];

/** The ids a server moves among: its folder's servers, or the top-level rows. */
function siblingsOf(serverId, servers, layout) {
  const folder = (layout.serverFolders ?? []).find((f) => f.serverIds.includes(serverId));
  if (folder) return { folder, ids: folder.serverIds.filter((id) => servers.some((s) => s.id === id)) };
  return { folder: null, ids: buildRows(servers, layout).map((r) => (r.kind === 'folder' ? r.folder.id : r.server.id)) };
}

/**
 * Move a server one step up or down in the rail — the keyboard and menu
 * alternative to drag-and-drop (WCAG 2.5.7). Inside a folder it moves within
 * the folder; at the top level it swaps with the neighbouring row (a folder
 * counts as one row). Returns the new 1-based position, or null if it could
 * not move. Exported so the server context menu can offer Move up / Move down.
 */
export function moveServerInRail(serverId, delta, servers = lastServers) {
  const layout = getPreferences().layout ?? { serverFolders: [], serverOrder: [] };
  const { folder, ids } = siblingsOf(serverId, servers, layout);
  const from = ids.indexOf(serverId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  if (folder) {
    updatePreferences('layout', {
      ...layout,
      serverFolders: layout.serverFolders.map((f) => (f.id === folder.id ? { ...f, serverIds: ids } : f))
    });
  } else {
    updatePreferences('layout', { ...layout, serverOrder: ids });
  }
  return to + 1;
}

/** Can this server move in that direction? (For disabling menu items.) */
export function canMoveServerInRail(serverId, delta, servers = lastServers) {
  const layout = getPreferences().layout ?? { serverFolders: [], serverOrder: [] };
  const { ids } = siblingsOf(serverId, servers, layout);
  const at = ids.indexOf(serverId);
  return at >= 0 && at + delta >= 0 && at + delta < ids.length;
}

/** "Server name, 3 mentions" / "Server name, unread" / "…, muted": the icon's accessible name. */
function railLabel(name, { mentions = 0, unread = false, muted = false } = {}) {
  const parts = [name];
  if (mentions > 0) parts.push(t('a11y.mentionCount', { count: mentions }));
  else if (unread) parts.push(t('a11y.unread'));
  if (muted) parts.push(t('a11y.muted'));
  return parts.join(', ');
}

/**
 * The 72px rail. Each icon carries Discord's two unread affordances: the white
 * pill on the left edge for any unread, and a red badge for mention counts.
 *
 * Keyboard: the rail is ONE tab stop (roving tabindex). ↑/↓/Home/End move
 * between icons, Enter opens, and Ctrl+Shift+↑/↓ moves the focused server.
 */
export default function ServerRail({
  servers = [],
  serverSettings = {},
  readStates = {},
  channels = [],
  activeServerId: selectedServerId,
  onSelectServer,
  onOpenCreateServerModal,
  onSelectHome,
  onJoinWithInvite,
  onServerContextMenu,
  onOpenDiscover,
  discoverActive = false,
  onMarkServersRead,
  pendingFriendCount = 0,
  mobileOpen = false
}) {
  // While Discover is open no server (nor Home) is the current page.
  const activeServerId = discoverActive ? null : selectedServerId;
  const { prefs, update } = useUserSettings();
  const layout = prefs.layout ?? { serverFolders: [], serverOrder: [] };
  const rows = useMemo(() => buildRows(servers, layout), [servers, layout]);
  const [dragging, setDragging] = useState(null);   // { serverId, fromFolderId }
  const [dropTarget, setDropTarget] = useState(null); // row key being hovered
  lastServers = servers;

  const saveLayout = (next) => update('layout', next);
  const rowKey = (row) => (row.kind === 'folder' ? `folder:${row.folder.id}` : `server:${row.server.id}`);

  /** Persist the current row order (ids of folders/servers top to bottom). */
  const orderFromRows = (list) => list.map((r) => (r.kind === 'folder' ? r.folder.id : r.server.id));

  const stripFromFolders = (folders, serverId) => folders
    .map((f) => ({ ...f, serverIds: f.serverIds.filter((id) => id !== serverId) }))
    .filter((f) => f.serverIds.length > 0);

  /** Drop server A onto server B → new folder holding both, at B's position. */
  const foldTogether = (movedId, ontoId) => {
    if (movedId === ontoId) return;
    let folders = stripFromFolders(layout.serverFolders ?? [], movedId);
    const folderId = `f${Date.now().toString(36)}`;
    folders = [...folders, { id: folderId, name: '', color: FOLDER_COLORS[folders.length % FOLDER_COLORS.length], collapsed: false, serverIds: [ontoId, movedId] }];
    const order = orderFromRows(rows).filter((id) => id !== movedId).map((id) => (id === ontoId ? folderId : id));
    saveLayout({ serverFolders: folders, serverOrder: order });
  };

  /** Drop a server onto a folder → join it. */
  const joinFolder = (movedId, folderId) => {
    let folders = stripFromFolders(layout.serverFolders ?? [], movedId);
    folders = folders.map((f) => (f.id === folderId ? { ...f, serverIds: [...f.serverIds, movedId] } : f));
    saveLayout({ serverFolders: folders, serverOrder: orderFromRows(rows).filter((id) => id !== movedId) });
  };

  /** Drop a server in the gap before a row → reorder (and leave any folder). */
  const placeBefore = (movedId, beforeKey) => {
    const folders = stripFromFolders(layout.serverFolders ?? [], movedId);
    const ids = orderFromRows(rows).filter((id) => id !== movedId);
    const beforeId = beforeKey === 'end' ? null : beforeKey.split(':')[1];
    const at = beforeId ? ids.indexOf(beforeId) : ids.length;
    ids.splice(at < 0 ? ids.length : at, 0, movedId);
    saveLayout({ serverFolders: folders, serverOrder: ids });
  };

  const toggleFolder = (folderId) => saveLayout({
    ...layout,
    serverFolders: (layout.serverFolders ?? []).map((f) => (f.id === folderId ? { ...f, collapsed: !f.collapsed } : f))
  });

  // Folder Settings (name, colour, mark read, ungroup): right-click, or
  // Shift+F10 / the context-menu key on a focused folder.
  const [folderMenu, setFolderMenu] = useState(null); // { folderId, x, y }
  const openFolderSettings = (folderId, x, y) => setFolderMenu({ folderId, x, y });
  const menuFolder = folderMenu ? (layout.serverFolders ?? []).find((f) => f.id === folderMenu.folderId) : null;

  const saveFolder = (folderId, { name, color }) => saveLayout({
    ...layout,
    serverFolders: (layout.serverFolders ?? []).map((f) => (f.id === folderId
      ? { ...f, name: (name ?? '').trim().slice(0, 60), color: color ?? null }
      : f))
  });

  /** Dissolve a folder: its servers take its place in the rail, in order. */
  const ungroupFolder = (folderId) => {
    const folder = (layout.serverFolders ?? []).find((f) => f.id === folderId);
    if (!folder) return;
    const order = orderFromRows(rows).flatMap((id) => (id === folderId ? folder.serverIds : [id]));
    saveLayout({
      ...layout,
      serverFolders: (layout.serverFolders ?? []).filter((f) => f.id !== folderId),
      serverOrder: order
    });
  };

  const dragProps = (serverId, fromFolderId = null) => ({
    draggable: true,
    onDragStart: (e) => { setDragging({ serverId, fromFolderId }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', serverId); },
    onDragEnd: () => { setDragging(null); setDropTarget(null); }
  });
  const dropOn = (key, handler) => ({
    onDragOver: (e) => { if (dragging) { e.preventDefault(); setDropTarget(key); } },
    onDragLeave: () => setDropTarget((cur) => (cur === key ? null : cur)),
    onDrop: (e) => { e.preventDefault(); if (dragging) handler(dragging.serverId); setDragging(null); setDropTarget(null); }
  });

  // Unread state per server. Every read-state row carries its channel's
  // `server_id` (services/messages.js getUnreadSummary), so every server the
  // user is in gets its pill and mention count, not only the one whose
  // channels happen to be loaded. `channels` is a fallback for a row created
  // locally before the server said which guild it belongs to. Rows with no
  // server are DMs and roll up onto the Home button.
  const { perServer, dmMentions } = useMemo(() => {
    const channelServer = new Map(channels.filter((c) => c.server_id).map((c) => [c.id, c.server_id]));
    const map = new Map();
    let dm = 0;
    for (const [channelId, state] of Object.entries(readStates)) {
      if (!state) continue;
      const serverId = state.server_id ?? channelServer.get(channelId) ?? null;
      if (!serverId) { dm += state.mention_count ?? 0; continue; }
      const entry = map.get(serverId) ?? { unread: false, mentions: 0 };
      if (state.unread) entry.unread = true;
      entry.mentions += state.mention_count ?? 0;
      map.set(serverId, entry);
    }
    return { perServer: map, dmMentions: dm };
  }, [channels, readStates]);

  // --- keyboard: one tab stop, arrows move within the rail (roving tabindex) ---
  const navRef = useRef(null);
  const [rovingKey, setRovingKey] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const activeKey = discoverActive ? 'explore' : activeServerId === 'home' ? 'home' : `server:${activeServerId}`;
  const itemKeys = useMemo(() => {
    const keys = ['home'];
    for (const row of rows) {
      if (row.kind === 'server') { keys.push(`server:${row.server.id}`); continue; }
      keys.push(`folder:${row.folder.id}`);
      const open = !row.folder.collapsed || row.servers.some((sv) => sv.id === activeServerId);
      if (open) for (const sv of row.servers) keys.push(`server:${sv.id}`);
    }
    keys.push('add', 'explore');
    return keys;
  }, [rows, activeServerId]);
  const tabKey = itemKeys.includes(rovingKey) ? rovingKey : (itemKeys.includes(activeKey) ? activeKey : 'home');

  const focusItem = (key) => {
    const el = [...(navRef.current?.querySelectorAll('[data-rail-key]') ?? [])].find((node) => node.dataset.railKey === key);
    if (el) { setRovingKey(key); el.focus(); }
  };

  const onRailKeyDown = (event) => {
    const key = event.target?.closest?.('[data-rail-key]')?.dataset.railKey;
    if (!key) return;
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    // Ctrl+Shift+↑/↓ moves the focused server: the alternative to dragging.
    if (vertical && event.shiftKey && (event.ctrlKey || event.metaKey)) {
      if (!key.startsWith('server:')) return;
      event.preventDefault();
      event.stopPropagation();
      const serverId = key.slice('server:'.length);
      const up = event.key === 'ArrowUp';
      const position = moveServerInRail(serverId, up ? -1 : 1, servers);
      const name = servers.find((sv) => sv.id === serverId)?.name ?? '';
      setAnnouncement(position
        ? t('rail.movedTo', { name, position })
        : t(up ? 'rail.alreadyFirst' : 'rail.alreadyLast', { name }));
      requestAnimationFrame(() => focusItem(key));
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = itemKeys.indexOf(key);
    let next = null;
    if (event.key === 'ArrowDown') next = itemKeys[Math.min(index + 1, itemKeys.length - 1)];
    else if (event.key === 'ArrowUp') next = itemKeys[Math.max(index - 1, 0)];
    else if (event.key === 'Home') next = itemKeys[0];
    else if (event.key === 'End') next = itemKeys[itemKeys.length - 1];
    if (next === null) return;
    event.preventDefault();
    focusItem(next);
  };

  // Clear the live region so the same message can be announced again.
  useEffect(() => {
    if (!announcement) return undefined;
    const id = setTimeout(() => setAnnouncement(''), 2500);
    return () => clearTimeout(id);
  }, [announcement]);

  const itemProps = (key) => ({
    'data-rail-key': key,
    tabIndex: key === tabKey ? 0 : -1,
    onFocus: () => setRovingKey(key)
  });

  return (
    // Below `md` the rail slides in together with the channel list as one
    // navigation drawer, so the conversation gets the whole width of a phone.
    <nav
      ref={navRef}
      aria-label={t('sidebar.servers')}
      aria-describedby="rail-keyboard-hint"
      onKeyDown={onRailKeyDown}
      className={`w-[72px] bg-d-base flex flex-col items-center pt-3 gap-2 shrink-0 select-none z-20 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:transition-transform max-md:pt-[max(0.75rem,env(safe-area-inset-top))] ${
        mobileOpen ? '' : 'max-md:-translate-x-full max-md:invisible'
      }`}
    >
      <span id="rail-keyboard-hint" className="sr-only">{t('rail.keyboardHint')}</span>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      <RailButton
        {...itemProps('home')}
        active={activeServerId === 'home'}
        onClick={onSelectHome}
        title={t('dm.directMessages')}
        label={railLabel(t('dm.directMessages'), { mentions: dmMentions + pendingFriendCount })}
        badge={dmMentions + pendingFriendCount}
        activeClass="bg-d-brand text-white"
      >
        <BrandMark className="w-7 h-7" />
      </RailButton>

      <div className="w-8 h-[2px] bg-d-hover2 rounded my-1 shrink-0" aria-hidden="true" />

      <div className="flex-1 w-full space-y-2 overflow-y-auto scrollbar-none flex flex-col items-center pb-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {rows.map((row) => {
          const key = rowKey(row);
          const gap = (
            <div
              key={`gap-${key}`}
              {...dropOn(`gap-${key}`, (id) => placeBefore(id, key))}
              className={`w-10 transition-[height] ${dropTarget === `gap-${key}` ? 'h-2 bg-d-brand rounded' : 'h-0'}`}
              aria-hidden="true"
            />
          );
          if (row.kind === 'server') {
            const server = row.server;
            const state = perServer.get(server.id) ?? { unread: false, mentions: 0 };
            const muted = Boolean(serverSettings[server.id]?.muted);
            return (
              <React.Fragment key={key}>
                {gap}
                <div
                  className={`w-full flex justify-center rounded-2xl transition-shadow ${dropTarget === key ? 'ring-2 ring-d-brand' : ''} ${dragging?.serverId === server.id ? 'opacity-40' : ''}`}
                  {...dragProps(server.id)}
                  {...dropOn(key, (id) => foldTogether(id, server.id))}
                >
                  <ServerIcon
                    {...itemProps(`server:${server.id}`)}
                    server={server}
                    active={activeServerId === server.id}
                    unread={Boolean(state.unread) && !muted}
                    badge={muted ? 0 : state.mentions}
                    muted={muted}
                    onSelect={() => onSelectServer(server.id)}
                    onContextMenu={(e) => { e.preventDefault(); onServerContextMenu?.(server, e.clientX, e.clientY); }}
                  />
                </div>
              </React.Fragment>
            );
          }

          // Folder row: a coloured tile that opens to reveal its servers.
          const { folder, servers: members } = row;
          const anyUnread = members.some((sv) => perServer.get(sv.id)?.unread && !serverSettings[sv.id]?.muted);
          const mentions = members.reduce((n, sv) => n + (serverSettings[sv.id]?.muted ? 0 : (perServer.get(sv.id)?.mentions ?? 0)), 0);
          const containsActive = members.some((sv) => sv.id === activeServerId);
          const open = !folder.collapsed || containsActive;
          const label = folder.name || members.map((sv) => sv.name).join(', ');
          return (
            <React.Fragment key={key}>
              {gap}
              <div
                className={`w-[56px] rounded-2xl py-1 flex flex-col items-center gap-2 transition-colors ${open ? 'bg-d-canvas/60' : ''} ${dropTarget === key ? 'ring-2 ring-d-brand' : ''}`}
                {...dropOn(key, (id) => joinFolder(id, folder.id))}
              >
                <RailButton
                  {...itemProps(`folder:${folder.id}`)}
                  onClick={() => toggleFolder(folder.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    // Beside the folder (like the keyboard path below), so the
                    // popover never covers the folder it is editing.
                    const rect = e.currentTarget.getBoundingClientRect();
                    openFolderSettings(folder.id, rect.right + 8, rect.top);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      openFolderSettings(folder.id, rect.right + 8, rect.top);
                    }
                  }}
                  title={label}
                  label={railLabel(t('rail.folderLabel', { name: label }), { mentions: open ? 0 : mentions, unread: !open && anyUnread })}
                  expanded={open}
                  unread={!open && anyUnread}
                  badge={open ? 0 : mentions}
                  activeClass=""
                >
                  {open ? (
                    <FolderOpen className="w-6 h-6" aria-hidden="true" style={{ color: folder.color ?? undefined }} />
                  ) : (
                    <div aria-hidden="true" className="grid grid-cols-2 gap-0.5 p-2 w-full h-full" style={{ color: folder.color ?? undefined }}>
                      {members.slice(0, 4).map((sv) => (
                        serverIconOf(sv)
                          ? <img key={sv.id} src={serverIconOf(sv)} alt="" className="w-full h-full rounded-full object-cover" />
                          : <span key={sv.id} className="w-full h-full rounded-full bg-current opacity-60" />
                      ))}
                    </div>
                  )}
                </RailButton>
                {open && members.map((server) => {
                  const state = perServer.get(server.id) ?? { unread: false, mentions: 0 };
                  const muted = Boolean(serverSettings[server.id]?.muted);
                  return (
                    <div key={server.id} className={`w-full flex justify-center ${dragging?.serverId === server.id ? 'opacity-40' : ''}`} {...dragProps(server.id, folder.id)}>
                      <ServerIcon
                        {...itemProps(`server:${server.id}`)}
                        server={server}
                        active={activeServerId === server.id}
                        unread={Boolean(state.unread) && !muted}
                        badge={muted ? 0 : state.mentions}
                        muted={muted}
                        onSelect={() => onSelectServer(server.id)}
                        onContextMenu={(e) => { e.preventDefault(); onServerContextMenu?.(server, e.clientX, e.clientY); }}
                      />
                    </div>
                  );
                })}
              </div>
            </React.Fragment>
          );
        })}
        <div
          {...dropOn('gap-end', (id) => placeBefore(id, 'end'))}
          className={`w-10 transition-[height] ${dropTarget === 'gap-end' ? 'h-2 bg-d-brand rounded' : 'h-0'}`}
          aria-hidden="true"
        />

        <RailButton
          {...itemProps('add')}
          onClick={onOpenCreateServerModal}
          title={t('server.addServer')}
          accent
        >
          <Plus className="w-6 h-6" aria-hidden="true" />
        </RailButton>

        {onOpenDiscover ? (
          // Server Discovery: public servers on this instance.
          <RailButton
            {...itemProps('explore')}
            onClick={onOpenDiscover}
            title={t('srv.exploreDiscover')}
            active={discoverActive}
            activeClass="bg-d-online text-white"
            accent
          >
            <Compass className="w-6 h-6" aria-hidden="true" />
          </RailButton>
        ) : (
          <RailButton {...itemProps('explore')} onClick={onJoinWithInvite} title={t('server.joinTitle')} accent>
            <Link2 className="w-6 h-6" aria-hidden="true" />
          </RailButton>
        )}
      </div>

      {/* Portalled: the rail is a drawer (its own stacking context) on phones,
          and the channel list paints over it on desktop. */}
      {menuFolder && createPortal(
        <FolderSettingsPopover
          folder={menuFolder}
          x={folderMenu.x}
          y={folderMenu.y}
          onSave={(values) => saveFolder(menuFolder.id, values)}
          onMarkRead={onMarkServersRead ? () => onMarkServersRead(menuFolder.serverIds) : undefined}
          onUngroup={() => ungroupFolder(menuFolder.id)}
          onClose={() => {
            const id = menuFolder.id;
            setFolderMenu(null);
            requestAnimationFrame(() => focusItem(`folder:${id}`));
          }}
        />,
        document.body
      )}
    </nav>
  );
}

/** Initials get smaller as there are more of them, like Discord's. */
function initialsClass(text) {
  if (/\p{Extended_Pictographic}/u.test(text)) return 'text-2xl leading-none';
  const length = Array.from(text).length;
  if (length <= 1) return 'text-lg font-semibold';
  if (length === 2) return 'text-base font-semibold';
  return 'text-sm font-semibold';
}

function ServerIcon({ server, active, unread, badge, muted, onSelect, onContextMenu, ...rest }) {
  // A dead icon URL must not leave a broken-image glyph in the rail; the
  // acronym is what Discord shows for a guild without an icon anyway.
  const [iconFailed, setIconFailed] = useState(false);
  const initials = serverInitials(server.name);
  return (
    <RailButton
      {...rest}
      active={active}
      unread={unread}
      badge={badge}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={server.name}
      label={railLabel(server.name, { mentions: badge, unread, muted })}
      dim={muted}
    >
      {serverIconOf(server) && !iconFailed ? (
        // Animated icons stay on their first frame until hovered or open.
        <AnimatedServerIcon server={server} active={active} alt="" width={48} height={48} decoding="async"
          onError={() => setIconFailed(true)} className="w-full h-full object-cover pointer-events-none" />
      ) : (
        <span aria-hidden="true" className={initialsClass(initials)}>{initials}</span>
      )}
    </RailButton>
  );
}

function RailButton({
  children, active, unread, badge = 0, onClick, onContextMenu, title, label, accent, activeClass, dim, expanded,
  ...rest
}) {
  return (
    <div className="relative group flex items-center justify-center w-full shrink-0">
      <span
        aria-hidden="true"
        className={`absolute left-0 w-1 bg-d-strong rounded-r transition-[height] duration-200 ${
          active ? 'h-10' : unread ? 'h-2' : 'h-0 group-hover:h-5'
        }`}
      />
      <button
        {...rest}
        type="button"
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={title}
        aria-label={label ?? title}
        aria-current={active ? 'page' : undefined}
        aria-expanded={expanded}
        className={`w-12 h-12 flex items-center justify-center overflow-hidden
          transition-[border-radius,background-color,color] duration-200 ${
          active
            ? `${activeClass ?? 'ring-2 ring-d-brand'} rounded-[16px]`
            : `rounded-[24px] hover:rounded-[16px] focus-visible:rounded-[16px] ${accent
              ? 'bg-d-canvas text-d-online hover:bg-d-online hover:text-white'
              : 'bg-d-canvas text-d-text hover:bg-d-brand hover:text-white'}`
        } ${dim ? 'opacity-50' : ''}`}
      >
        {children}
      </button>
      {badge > 0 && (
        <MentionBadge
          count={badge}
          decorative
          ring="var(--color-d-base)"
          className="absolute -bottom-1 right-1.5 pointer-events-none"
        />
      )}
    </div>
  );
}
