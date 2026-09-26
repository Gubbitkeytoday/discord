// Context for the next "Create channel" dialog.
//
// The dialog is opened by the app shell with only a channel type, but where
// it was opened from matters: the "+" on a category should preselect that
// category, and a voice channel belongs under the voice category. The sidebar
// records that context here right before asking the shell to open the dialog,
// and the dialog reads it once on mount. An intent older than a few seconds is
// ignored, so a stale one can never leak into an unrelated dialog.

let pending = null;
const MAX_AGE_MS = 5000;

/**
 * @param {{ serverId?: string, categoryId?: string|null, categoryName?: string|null,
 *           categories?: Array<{id: string, name: string, types?: string[]}>, type?: string }} intent
 */
export function setCreateChannelIntent(intent) {
  pending = { ...intent, at: Date.now() };
}

export function takeCreateChannelIntent() {
  const intent = pending;
  pending = null;
  if (!intent || Date.now() - intent.at > MAX_AGE_MS) return null;
  return intent;
}

/**
 * The category a new channel of `type` should default to: the first category
 * whose channels are all voice-like for voice/stage, otherwise the first whose
 * channels are text-like — Discord's behaviour.
 */
export function defaultCategoryFor(type, categories = []) {
  const voiceLike = type === 'voice' || type === 'stage';
  const fits = (c) => {
    const types = c.types ?? [];
    if (types.length === 0) return false;
    return voiceLike
      ? types.every((x) => x === 'voice' || x === 'stage')
      : types.every((x) => x !== 'voice' && x !== 'stage');
  };
  return categories.find(fits) ?? categories[0] ?? null;
}

// Which tab Channel Settings should open on (e.g. "Edit permissions" from a
// category menu). Same one-shot, short-lived hand-off as above.
let pendingTab = null;

export function setChannelSettingsTab(tab) {
  pendingTab = { tab, at: Date.now() };
}

export function takeChannelSettingsTab() {
  const value = pendingTab;
  pendingTab = null;
  if (!value || Date.now() - value.at > MAX_AGE_MS) return null;
  return value.tab;
}
