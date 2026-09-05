import React, { useMemo, useState } from 'react';
import { Plus, Compass, Folder, FolderOpen } from 'lucide-react';
import { useUserSettings } from '../hooks/useUserSettings';
import { t } from '../i18n/index.jsx';

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

/**
 * The 72px rail. Each icon carries Discord's two unread affordances: the white
 * pill on the left edge for any unread, and a red badge for mention counts.
 */
export default function ServerRail({
  servers = [],
  serverSettings = {},
  readStates = {},
  channels = [],
  activeServerId,
  onSelectServer,
  onOpenCreateServerModal,
  onSelectHome,
  onJoinWithInvite,
  onServerContextMenu,
  pendingFriendCount = 0
}) {
  const { prefs, update } = useUserSettings();
  const layout = prefs.layout ?? { serverFolders: [], serverOrder: [] };
  const rows = useMemo(() => buildRows(servers, layout), [servers, layout]);
  const [dragging, setDragging] = useState(null);   // { serverId, fromFolderId }
  const [dropTarget, setDropTarget] = useState(null); // row key being hovered

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

  const renameFolder = (folderId) => {
    const folder = (layout.serverFolders ?? []).find((f) => f.id === folderId);
    // A native prompt keeps this dependency-free; the name is cosmetic.
    const name = window.prompt(t('rail.folderName'), folder?.name ?? '');
    if (name === null) return;
    saveLayout({ ...layout, serverFolders: (layout.serverFolders ?? []).map((f) => (f.id === folderId ? { ...f, name: name.trim().slice(0, 60) } : f)) });
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

  // Mentions roll up from a server's channels onto its icon. Channels for
  // servers we have not opened are not loaded, so this counts what we know —
  // the same trade-off Discord makes before a guild is hydrated.
  const perServer = useMemo(() => {
    const map = new Map();
    for (const channel of channels) {
      if (!channel.server_id) continue;
      const state = readStates[channel.id];
      if (!state) continue;
      const entry = map.get(channel.server_id) ?? { unread: false, mentions: 0 };
      if (state.unread) entry.unread = true;
      entry.mentions += state.mention_count ?? 0;
      map.set(channel.server_id, entry);
    }
    return map;
  }, [channels, readStates]);

  const dmMentions = useMemo(() => {
    const guildChannelIds = new Set(channels.filter((c) => c.server_id).map((c) => c.id));
    return Object.entries(readStates)
      .filter(([id]) => !guildChannelIds.has(id))
      .reduce((n, [, state]) => n + (state?.mention_count ?? 0), 0);
  }, [readStates, channels]);

  return (
    <nav aria-label={t('sidebar.servers')} className="w-[72px] bg-d-base flex flex-col items-center py-3 gap-2 shrink-0 select-none z-20">
      <RailButton
        active={activeServerId === 'home'}
        onClick={onSelectHome}
        title={t('dm.directMessages')}
        badge={dmMentions + pendingFriendCount}
        activeClass="bg-d-brand text-white"
      >
        <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
      </RailButton>

      <div className="w-8 h-[2px] bg-d-hover2 rounded my-1" />

      <div className="flex-1 w-full space-y-2 overflow-y-auto scrollbar-none flex flex-col items-center">
        {rows.map((row) => {
          const key = rowKey(row);
          const gap = (
            <div
              key={`gap-${key}`}
              {...dropOn(`gap-${key}`, (id) => placeBefore(id, key))}
              className={`w-10 transition-all ${dropTarget === `gap-${key}` ? 'h-2 bg-d-brand rounded' : 'h-0'}`}
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
                    server={server}
                    active={activeServerId === server.id}
                    unread={state.unread && !muted}
                    badge={muted ? 0 : state.mentions}
                    dim={muted}
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
                  onClick={() => toggleFolder(folder.id)}
                  onContextMenu={(e) => { e.preventDefault(); renameFolder(folder.id); }}
                  title={label}
                  unread={!open && anyUnread}
                  badge={open ? 0 : mentions}
                  activeClass=""
                >
                  {open ? (
                    <FolderOpen className="w-6 h-6" style={{ color: folder.color ?? undefined }} />
                  ) : (
                    <div className="grid grid-cols-2 gap-0.5 p-2 w-full h-full" style={{ color: folder.color ?? undefined }}>
                      {members.slice(0, 4).map((sv) => (
                        sv.icon_url
                          ? <img key={sv.id} src={sv.icon_url} alt="" className="w-full h-full rounded-full object-cover" />
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
                        server={server}
                        active={activeServerId === server.id}
                        unread={state.unread && !muted}
                        badge={muted ? 0 : state.mentions}
                        dim={muted}
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
          className={`w-10 transition-all ${dropTarget === 'gap-end' ? 'h-2 bg-d-brand rounded' : 'h-0'}`}
          aria-hidden="true"
        />

        <RailButton
          onClick={onOpenCreateServerModal}
          title={t('server.addServer')}
          accent
        >
          <Plus className="w-6 h-6" />
        </RailButton>

        <RailButton onClick={onJoinWithInvite} title={t('server.joinTitle')} accent>
          <Compass className="w-6 h-6" />
        </RailButton>
      </div>
    </nav>
  );
}

function ServerIcon({ server, active, unread, badge, dim, onSelect, onContextMenu }) {
  return (
    <RailButton active={active} unread={unread} badge={badge} onClick={onSelect} onContextMenu={onContextMenu} title={server.name} dim={dim}>
      {server.icon_url ? (
        <img src={server.icon_url} alt="" className="w-full h-full object-cover pointer-events-none" />
      ) : (
        <span className="font-semibold text-sm text-d-strong">{server.name.substring(0, 2).toUpperCase()}</span>
      )}
    </RailButton>
  );
}

function RailButton({
  children, active, unread, badge = 0, onClick, onContextMenu, title, accent, activeClass, dim
}) {
  return (
    <div className="relative group flex items-center justify-center w-full">
      <span
        aria-hidden="true"
        className={`absolute left-0 w-1 bg-white rounded-r transition-all duration-200 ${
          active ? 'h-10' : unread ? 'h-2' : 'h-0 group-hover:h-5'
        }`}
      />
      <button
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={title}
        aria-label={title}
        aria-current={active ? 'page' : undefined}
        className={`w-12 h-12 rounded-[24px] hover:rounded-[16px] flex items-center justify-center overflow-hidden transition-all duration-200 ${
          active
            ? `${activeClass ?? 'ring-2 ring-d-brand'} rounded-[16px]`
            : accent
            ? 'bg-d-canvas text-d-online hover:bg-d-online hover:text-white'
            : 'bg-d-canvas text-d-text hover:bg-d-brand hover:text-white'
        } ${dim ? 'opacity-50' : ''}`}
      >
        {children}
      </button>
      {badge > 0 && (
        <span className="absolute -bottom-0.5 right-2 bg-d-danger text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center border-2 border-d-base">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </div>
  );
}
