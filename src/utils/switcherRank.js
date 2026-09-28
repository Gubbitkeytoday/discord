// ============================================================================
//  Quick switcher matching (Ctrl+K). Pure, so it is testable from Node.
// ============================================================================

/**
 * Entries whose label matches `query`, best first: prefix, then word prefix,
 * then substring; unread breaks ties. The channel you are in is a result
 * too (typing "gen" in #general must list #general) — it only sorts after
 * equally good matches, since jumping to it goes nowhere.
 */
export function rankSwitcherEntries(pool, query, { activeId = null, limit = 20 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  return (pool ?? [])
    .map((entry) => {
      const label = entry.label?.toLowerCase() ?? '';
      if (label.startsWith(q)) return { entry, score: 0 };
      if (label.split(/[\s_-]+/).some((word) => word.startsWith(q))) return { entry, score: 1 };
      if (label.includes(q)) return { entry, score: 2 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score
      || Number(a.entry.id === activeId) - Number(b.entry.id === activeId)
      || (b.entry.unread ?? 0) - (a.entry.unread ?? 0))
    .slice(0, limit)
    .map((r) => r.entry);
}
