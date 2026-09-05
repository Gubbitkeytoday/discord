// ============================================================================
//  A bot's rich embed, and the buttons / select menus under a message.
//
//  Both are entirely bot-authored data, so everything here treats its input as
//  untrusted: links are rendered only when they are http(s), images get a
//  fixed box rather than whatever the source claims, and text is plain (the
//  markdown parser is deliberately not applied to embed fields, so a bot
//  cannot forge a mention that pings a room).
// ============================================================================

import React, { useState } from 'react';
import { ExternalLink, Loader2, ChevronDown } from 'lucide-react';
import { post } from '../api';
import { t } from '../i18n/index.jsx';

const httpOnly = (url) => (/^https?:\/\//i.test(String(url ?? '')) ? url : null);

export function RichEmbed({ embed }) {
  if (!embed) return null;
  const accent = /^#[0-9a-f]{6}$/i.test(embed.color ?? '') ? embed.color : 'var(--color-d-edge)';
  const titleHref = httpOnly(embed.url);

  return (
    <article
      className="mt-1 max-w-[520px] rounded-md bg-d-surface/70 border-l-4 overflow-hidden"
      style={{ borderLeftColor: accent }}
    >
      <div className="p-3 flex gap-3">
        <div className="min-w-0 flex-1">
          {embed.author?.name && (
            <div className="flex items-center gap-1.5 mb-1 min-w-0">
              {httpOnly(embed.author.icon_url) && (
                <img src={embed.author.icon_url} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
              )}
              <span className="text-xs font-semibold text-d-strong truncate">{embed.author.name}</span>
            </div>
          )}

          {embed.title && (
            titleHref ? (
              <a
                href={titleHref}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[15px] font-bold text-d-link hover:underline inline-flex items-center gap-1 break-words"
              >
                {embed.title}
                <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
              </a>
            ) : (
              <h4 className="text-[15px] font-bold text-d-strong break-words">{embed.title}</h4>
            )
          )}

          {embed.description && (
            <p className="text-sm text-d-text2 mt-1 whitespace-pre-line break-words">{embed.description}</p>
          )}

          {embed.fields?.length > 0 && (
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-3 gap-y-2 mt-2">
              {embed.fields.map((field, i) => (
                <div key={i} className={field.inline ? 'sm:col-span-1' : 'sm:col-span-3'}>
                  <dt className="text-xs font-bold text-d-strong break-words">{field.name}</dt>
                  <dd className="text-sm text-d-text2 whitespace-pre-line break-words">{field.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {embed.image?.url && httpOnly(embed.image.url) && (
            <img
              src={embed.image.url}
              alt=""
              loading="lazy"
              className="mt-3 rounded max-h-80 w-auto max-w-full object-contain bg-d-canvas"
            />
          )}

          {(embed.footer?.text || embed.timestamp) && (
            <div className="flex items-center gap-1.5 mt-2 text-[11px] text-d-text3">
              {httpOnly(embed.footer?.icon_url) && (
                <img src={embed.footer.icon_url} alt="" className="w-4 h-4 rounded-full object-cover" />
              )}
              {embed.footer?.text && <span className="truncate">{embed.footer.text}</span>}
              {embed.footer?.text && embed.timestamp && <span aria-hidden="true">·</span>}
              {embed.timestamp && <time dateTime={embed.timestamp}>{new Date(embed.timestamp).toLocaleString()}</time>}
            </div>
          )}
        </div>

        {embed.thumbnail?.url && httpOnly(embed.thumbnail.url) && (
          <img
            src={embed.thumbnail.url}
            alt=""
            loading="lazy"
            className="w-20 h-20 rounded object-cover shrink-0 bg-d-canvas"
          />
        )}
      </div>
    </article>
  );
}

const BUTTON_STYLES = {
  primary:   'bg-d-brand hover:bg-d-brand-hover text-white',
  secondary: 'bg-d-control2 hover:bg-d-control text-d-strong',
  success:   'bg-d-success hover:bg-d-successhover text-white',
  danger:    'bg-d-danger hover:opacity-90 text-white',
  link:      'bg-d-control2 hover:bg-d-control text-d-strong'
};

/**
 * The component rows under a bot message. Pressing a button posts an
 * interaction and shows a spinner until the bot answers — `pending` is keyed
 * by custom_id so two people pressing different buttons do not fight.
 */
export function MessageComponents({ message, onToast }) {
  const [pending, setPending] = useState(null);
  const rows = Array.isArray(message.components) ? message.components : [];
  if (rows.length === 0) return null;

  const press = async (customId, values = []) => {
    setPending(customId);
    try {
      await post(`/api/messages/${message.id}/interactions`, { custom_id: customId, values });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      // The bot's reply arrives as its own message or an edit; either way the
      // press itself is done once the request returns.
      setPending(null);
    }
  };

  return (
    <div className="mt-2 space-y-2 max-w-[520px]">
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="flex flex-wrap gap-2">
          {(row.components ?? []).map((component, index) => {
            if (component.type === 'select') {
              return (
                <SelectMenu
                  key={component.custom_id ?? index}
                  component={component}
                  busy={pending === component.custom_id}
                  onPick={(values) => press(component.custom_id, values)}
                />
              );
            }
            const style = BUTTON_STYLES[component.style] ?? BUTTON_STYLES.secondary;
            if (component.style === 'link') {
              return (
                <a
                  key={index}
                  href={httpOnly(component.url) ?? '#'}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={`inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-md ${style}`}
                >
                  {component.emoji && <span aria-hidden="true">{component.emoji}</span>}
                  {component.label}
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                </a>
              );
            }
            const busy = pending === component.custom_id;
            return (
              <button
                key={component.custom_id ?? index}
                type="button"
                disabled={component.disabled || busy}
                onClick={() => press(component.custom_id)}
                className={`inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${style}`}
              >
                {busy
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  : component.emoji && <span aria-hidden="true">{component.emoji}</span>}
                {component.label}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SelectMenu({ component, busy, onPick }) {
  const [value, setValue] = useState('');
  const id = `select-${component.custom_id}`;
  return (
    <div className="relative w-full max-w-[320px]">
      <label htmlFor={id} className="sr-only">{component.placeholder || t('bot.selectOption')}</label>
      <select
        id={id}
        value={value}
        disabled={component.disabled || busy}
        onChange={(e) => { setValue(e.target.value); if (e.target.value) onPick([e.target.value]); }}
        className="w-full appearance-none bg-d-input text-d-strong rounded-md pl-3 pr-8 py-2 text-sm outline-none focus:ring-2 focus:ring-d-brand disabled:opacity-50"
      >
        <option value="">{component.placeholder || t('bot.selectOption')}</option>
        {component.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.emoji ? `${option.emoji} ` : ''}{option.label}
          </option>
        ))}
      </select>
      {busy
        ? <Loader2 className="w-4 h-4 animate-spin text-d-text3 absolute right-2 top-1/2 -translate-y-1/2" aria-hidden="true" />
        : <ChevronDown className="w-4 h-4 text-d-text3 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />}
    </div>
  );
}

export default RichEmbed;
