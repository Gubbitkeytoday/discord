import { useCallback, useMemo } from 'react';
import { useUserSettings, getPreferences, updatePreferences } from '../../hooks/useUserSettings';

// Stored as one flat list of "serverId/categoryId" strings rather than a map
// per server: the settings service merges objects key by key, so a server
// removed from a map would come back, while an array is replaced whole.
const KEY = 'collapsedCategories';
const MAX = 500;

const entry = (serverId, categoryId) => `${serverId}/${categoryId}`;

function readList() {
  const list = getPreferences().layout?.[KEY];
  return Array.isArray(list) ? list.filter((v) => typeof v === 'string') : [];
}

/**
 * Remembered category collapse, per server, following the account
 * (prefs.layout.collapsedCategories). Replaces ChannelSidebar's component
 * state `collapsed`, which reset on every navigation.
 *
 *   const { isCollapsed, toggle } = useCollapsedCategories(server.id);
 *   <button aria-expanded={!isCollapsed(cat.id)} onClick={() => toggle(cat.id)}>
 */
export function useCollapsedCategories(serverId) {
  const { prefs } = useUserSettings();
  const list = prefs.layout?.[KEY];
  const collapsed = useMemo(() => {
    const prefix = `${serverId}/`;
    return new Set((Array.isArray(list) ? list : [])
      .filter((v) => typeof v === 'string' && v.startsWith(prefix))
      .map((v) => v.slice(prefix.length)));
  }, [list, serverId]);

  const setCollapsed = useCallback((categoryId, value) => {
    if (!serverId || !categoryId) return;
    const key = entry(serverId, categoryId);
    const rest = readList().filter((v) => v !== key);
    // Newest last, so the oldest collapse state is what falls off the end.
    const next = (value ? [...rest, key] : rest).slice(-MAX);
    updatePreferences('layout', { [KEY]: next });
  }, [serverId]);

  const isCollapsed = useCallback((categoryId) => collapsed.has(String(categoryId)), [collapsed]);
  const toggle = useCallback(
    (categoryId) => setCollapsed(categoryId, !collapsed.has(String(categoryId))),
    [collapsed, setCollapsed]
  );
  return { collapsed, isCollapsed, toggle, setCollapsed };
}

export default useCollapsedCategories;
