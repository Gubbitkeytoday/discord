import React, { memo } from 'react';
import { MessagesSquare, Pin, UserPlus } from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import { formatTime, formatFullTimestamp } from '../../utils/messageGrouping';

export const SYSTEM_TYPES = new Set([
  'thread_created', 'pin', 'channel_pinned_message', 'join', 'member_join', 'guild_member_join'
]);

/** Put a React node where a translation says {name}. */
function withName(key, node) {
  return t(key).split('{name}').map((part, i) => (
    <React.Fragment key={i}>{i > 0 && node}{part}</React.Fragment>
  ));
}

/**
 * Thread created / pinned / joined: a compact system line, not a message
 * signed by whoever triggered it (Discord's style). It is still an article in
 * the log, so arrow-key navigation and screen readers reach it.
 */
function SystemMessage({ msg, use24Hour, actions, rowProps }) {
  const name = msg.display_name ?? msg.username ?? '';
  const who = (
    <button type="button" tabIndex={-1} onClick={() => actions.openProfile(msg.user_id)} className="font-semibold text-d-strong hover:underline">
      {name}
    </button>
  );
  let Icon = MessagesSquare;
  let body;
  if (msg.type === 'thread_created') {
    body = (
      <>
        {withName('system.threadStarted', who)}{' '}
        {msg.thread_id ? (
          <button type="button" tabIndex={-1} onClick={() => actions.selectChannel(msg.thread_id)} className="font-semibold text-d-strong hover:underline">
            {msg.content}
          </button>
        ) : <span className="font-semibold text-d-strong">{msg.content}</span>}
      </>
    );
  } else if (msg.type === 'pin' || msg.type === 'channel_pinned_message') {
    Icon = Pin;
    body = (
      <>
        {withName('system.pinned', who)}{' '}
        <button type="button" tabIndex={-1} onClick={actions.openPins} className="font-semibold text-d-strong hover:underline">
          {t('system.seePins')}
        </button>
      </>
    );
  } else {
    Icon = UserPlus;
    body = withName('system.joined', who);
  }
  return (
    <div
      {...rowProps}
      id={`message-${msg.id}`}
      role="article"
      aria-roledescription={t('a11y.systemMessage')}
      className="message-row flex items-center gap-4 max-sm:gap-3 px-2 -mx-2 py-1 text-sm text-d-text2 rounded outline-none focus-visible:ring-2 focus-visible:ring-d-brand focus-visible:ring-inset"
    >
      <span className="w-10 shrink-0 flex justify-center text-d-text3" aria-hidden="true">
        <Icon className="w-4 h-4" />
      </span>
      <p className="min-w-0 flex-1 leading-relaxed">
        {body}
        <time dateTime={msg.created_at} title={formatFullTimestamp(msg.created_at)} className="ml-2 text-xs text-d-text3">
          {formatTime(msg.created_at, undefined, use24Hour)}
        </time>
      </p>
    </div>
  );
}

export default memo(SystemMessage);
