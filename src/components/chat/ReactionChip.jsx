import React, { memo } from 'react';
import { t } from '../../i18n/index.jsx';
import { shortcodeLabel } from '../../chat/emojiShortcodes.js';

/**
 * One reaction pill.
 *
 * Discord shows who reacted on hover, and the data for that already rides along
 * in `reaction_details.user_ids` — so this costs no request. The list is capped
 * because a popular reaction can carry hundreds of ids and a tooltip that fills
 * the screen is worse than one that says "and 40 others".
 */
function ReactionChip({ reaction, messageId, onToggle, nameFor }) {
  const ids = reaction.user_ids ?? [];
  const shown = ids.slice(0, 8).map(nameFor);
  const rest = ids.length - shown.length;

  const who = ids.length === 0
    ? t('chat.peopleCount', { count: reaction.count })
    : rest > 0
      ? t('chat.reactedByMore', { names: shown.join(', '), count: rest })
      : t('chat.reactedBy', { names: shown.join(', ') });

  return (
    <button
      type="button"
      onClick={() => onToggle(messageId, reaction.emoji)}
      title={`${who} — ${reaction.emoji}`}
      aria-label={`${shortcodeLabel(reaction.emoji)} ${reaction.count} · ${who}`}
      aria-pressed={Boolean(reaction.me)}
      className={`text-xs px-2 py-0.5 min-h-7 pointer-coarse:min-h-9 pointer-coarse:px-2.5 rounded-md flex items-center gap-1 transition-colors border ${
        reaction.me
          ? 'bg-d-brand/20 border-d-brand text-d-mention'
          : 'bg-d-surface hover:bg-d-hover border-d-divider text-d-text'
      }`}
    >
      <span aria-hidden="true">{reaction.emoji}</span>
      <span className="font-semibold text-xs" aria-hidden="true">{reaction.count}</span>
    </button>
  );
}

export default memo(ReactionChip);
