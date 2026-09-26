import { getPreferences, updatePreferences } from '../../hooks/useUserSettings';

const MAX = 20;

/**
 * Most-recently-visited destinations (channels, DMs, servers) for the quick
 * switcher's "Recent" section, following the account in
 * prefs.layout.recentDestinations = [{ kind, id, at }] (newest first).
 *
 * Call it on every navigation (App's channel change) as well as on a
 * switcher pick, so "recent" means visited, not only jumped-to:
 *   recordRecentDestination({ kind: 'text', id: channel.id });
 */
export function recordRecentDestination({ kind, id }) {
  if (!kind || !id) return;
  const list = getRecentDestinations();
  if (list[0]?.id === String(id) && list[0]?.kind === kind) return;
  const next = [{ kind, id: String(id), at: Date.now() }, ...list.filter((d) => d.id !== String(id))].slice(0, MAX);
  updatePreferences('layout', { recentDestinations: next });
}

export function getRecentDestinations() {
  const list = getPreferences().layout?.recentDestinations;
  return Array.isArray(list) ? list.filter((d) => d && typeof d.id === 'string') : [];
}
