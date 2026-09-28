import React from 'react';
import { Hash, Volume2, Megaphone, MessagesSquare, Lock } from 'lucide-react';
import { proxiedImageUrl } from '../../utils/media';

const CUSTOM = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{1,20})>$/;
const TYPE_GLYPH = { voice: Volume2, stage: Volume2, announcement: Megaphone, forum: MessagesSquare };

/** { kind: 'unicode', text } | { kind: 'custom', id, name, animated } | null */
export function channelEmojiOf(channel) {
  const value = channel?.icon_emoji;
  if (!value) return null;
  const custom = CUSTOM.exec(value);
  if (custom) return { kind: 'custom', animated: custom[1] === 'a', name: custom[2], id: custom[3] };
  return { kind: 'unicode', text: value };
}

/**
 * A channel's emoji in place of its # / speaker glyph, with the type glyph as
 * a small corner badge so a voice channel is still recognisably voice (the
 * same pattern as the private-channel lock). Returns null when the channel has
 * no emoji, so the caller keeps rendering its usual glyph:
 *
 *   {channelEmojiOf(c) ? <ChannelEmojiIcon channel={c} emojis={serverEmojis} /> : <Hash … />}
 *
 * Decorative: the channel name beside it is the accessible name.
 */
export default function ChannelEmojiIcon({ channel, emojis = [], size = 20, showType = true, className = '' }) {
  const emoji = channelEmojiOf(channel);
  if (!emoji) return null;
  const Glyph = TYPE_GLYPH[channel.type] ?? Hash;
  let body;
  if (emoji.kind === 'custom') {
    const found = emojis.find((e) => String(e.id) === emoji.id);
    if (!found?.url) return null;
    body = <img src={proxiedImageUrl(found.url)} alt="" width={size} height={size} className="object-contain" style={{ width: size, height: size }} />;
  } else {
    body = <span style={{ fontSize: size * 0.85, lineHeight: 1 }}>{emoji.text}</span>;
  }
  return (
    <span aria-hidden="true" className={`relative inline-flex items-center justify-center shrink-0 ${className}`} style={{ width: size, height: size }}>
      {body}
      {showType && (channel.type !== 'text' || channel.is_private) && (
        <span className="absolute -bottom-1 -right-1 w-3 h-3 rounded-full bg-d-surface flex items-center justify-center">
          {channel.is_private
            ? <Lock className="w-2 h-2 text-d-text2" strokeWidth={3} />
            : <Glyph className="w-2 h-2 text-d-text2" strokeWidth={3} />}
        </span>
      )}
    </span>
  );
}
