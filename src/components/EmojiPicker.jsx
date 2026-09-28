import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEscapeLayer } from '../hooks/useFocusTrap';
import { Search, Clock, Star, X } from 'lucide-react';
import { t, useLocaleCode } from '../i18n/index.jsx';
import { proxiedImageUrl } from '../utils/media';
import { searchShortcodes, shortcodeLabel } from '../chat/emojiShortcodes.js';
import { loadRecentEmoji as loadRecent, saveRecentEmoji as saveRecent } from '../chat/recentEmoji.js';

const COLUMNS = 9;



/**
 * Unicode emoji grouped the way Discord groups them. Not the full 3,600-entry
 * table — a curated set that covers ordinary chat without shipping a megabyte
 * of data. Server emojis are merged in as their own category.
 */
export const emojiCategories = () => [
  {
    key: 'smileys', label: t('emoji.smileys'), icon: '😀',
    emojis: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 🤖'.split(' ')
  },
  {
    key: 'people', label: t('emoji.people'), icon: '👋',
    emojis: '👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁️ 👅 👄 💋 🩸 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙈 🙉 🙊'.split(' ')
  },
  {
    key: 'nature', label: t('emoji.nature'), icon: '🐶',
    emojis: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪱 🐛 🦋 🐌 🐞 🐜 🪰 🕷️ 🦂 🐢 🐍 🦎 🐙 🦑 🦐 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦛 🐪 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🐈 🌵 🎄 🌲 🌳 🌴 🪵 🌱 🌿 ☘️ 🍀 🎍 🍃 🍂 🍁 🌾 🌷 🌹 🥀 🌺 🌸 🌼 🌻 🌞 🌝 🌛 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ⛄ 💧 🌊'.split(' ')
  },
  {
    key: 'food', label: t('emoji.food'), icon: '🍔',
    emojis: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧇 🥞 🧈 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 ☕ 🍵 🧋 🥤 🧃 🍺 🍻 🥂 🍷 🥃 🍸 🍹'.split(' ')
  },
  {
    key: 'activity', label: t('emoji.activity'), icon: '⚽',
    emojis: '⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🕹️ 🎰 🧩'.split(' ')
  },
  {
    key: 'travel', label: t('emoji.travel'), icon: '🚗',
    emojis: '🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🛵 🏍️ 🛺 🚲 🛴 🚨 🚔 🚍 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏔️ ⛰️ 🌋 🗻 🏕️ ⛺ 🏠 🏡 🏘️ 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🛕 🕍 🌃 🌆 🌇 🌉 🌌'.split(' ')
  },
  {
    key: 'objects', label: t('emoji.objects'), icon: '💻',
    emojis: '⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽️ 📞 ☎️ 📟 📠 📺 📻 🎙️ ⏱️ ⏰ ⌛ ⏳ 🔋 🔌 💡 🔦 🕯️ 🧯 🛢️ 💸 💵 💴 💶 💷 💰 💳 💎 ⚖️ 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 💊 💉 🩹 🩺 🚪 🛏️ 🛋️ 🪑 🚽 🚿 🛁 🧴 🧷 🧹 🧺 🧻 🧼 🪥 🔑 🗝️ 🎁 🎀 🎈 🎉 🎊 🎃 🎄 🧧 ✉️ 📩 📨 📧 📮 📦 📫 📪 📄 📃 📑 📊 📈 📉 🗒️ 📅 📆 🗓️ 📇 🗃️ 🗄️ 📋 📁 📂 🗂️ 📰 📓 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎'.split(' ')
  },
  {
    key: 'symbols', label: t('emoji.symbols'), icon: '❤️',
    emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿ 🅿️ 🈳 🈂️ 🛂 🛃 🛄 🛅 🚹 🚺 🚼 ⚧ 🚻 🚮 🎦 📶 🈁 🔣 ℹ️ 🔤 🔡 🔠 🆖 🆗 🆙 🆒 🆕 🆓'.split(' ')
  },
  {
    key: 'flags', label: t('emoji.flags'), icon: '🏳️',
    emojis: '🏳️ 🏴 🏁 🚩 🏳️‍🌈 🏳️‍⚧️ 🏴‍☠️ 🇹🇭 🇯🇵 🇰🇷 🇨🇳 🇺🇸 🇬🇧 🇫🇷 🇩🇪 🇮🇹 🇪🇸 🇷🇺 🇧🇷 🇮🇳 🇦🇺 🇨🇦 🇸🇬 🇲🇾 🇻🇳 🇵🇭 🇮🇩 🇹🇼 🇭🇰 🇳🇿 🇲🇽 🇦🇷 🇳🇱 🇸🇪 🇳🇴 🇩🇰 🇫🇮 🇵🇱 🇹🇷 🇦🇪 🇸🇦 🇿🇦 🇪🇬'.split(' ')
  }
];

/**
 * Full emoji picker: categories, search, recents and server emoji.
 *
 * @param onPick receives either { char } for unicode or { id, name, url } for a
 *               custom emoji, so the caller can insert the right token.
 */
export default function EmojiPicker({ customEmojis = [], externalGroups = [], onPick, onClose, anchorClass = '' }) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('recent');
  const [recent, setRecent] = useState(loadRecent);
  const [cursor, setCursor] = useState(0);
  const searchRef = useRef(null);
  const scrollRef = useRef(null);
  const gridRef = useRef(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEscapeLayer(() => onClose?.());

  const pick = (entry) => {
    saveRecent(entry);
    setRecent(loadRecent());
    onPick(entry);
  };

  // Search spans every category plus custom emoji; category tabs are ignored
  // while a query is active, exactly like Discord.
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/:/g, '');
    if (!q) return null;

    const custom = [...customEmojis, ...externalGroups.flatMap((g) => g.emojis)]
      .filter((e) => e.name.toLowerCase().includes(q))
      .map((e) => ({ id: e.id, name: e.name, url: e.url, custom: true }));

    // Unicode emoji by shortcode (":thumbsup"), then whole categories whose
    // label matches ("food").
    const named = searchShortcodes(q, 60).map(({ char }) => ({ char }));
    const seen = new Set(named.map((e) => e.char));
    const byCategory = emojiCategories()
      .filter((c) => c.label.toLowerCase().includes(q) || c.key.includes(q))
      .flatMap((c) => c.emojis.filter((char) => !seen.has(char)).map((char) => ({ char })));

    return [...custom, ...named, ...byCategory];
  }, [query, customEmojis, externalGroups]);

  // Translated labels are memoised; recompute when the language changes.
  const locale = useLocaleCode();
  const categories = useMemo(() => ([
    { key: 'recent', label: t('emoji.recent'), icon: '🕐', entries: recent },
    ...(customEmojis.length
      ? [{
          key: 'custom', label: t('emoji.thisServer'), icon: '⭐',
          entries: customEmojis.map((e) => ({ id: e.id, name: e.name, url: e.url, custom: true }))
        }]
      : []),
    // Emoji from the viewer's other servers — Discord lists each server as its
    // own section. Using one needs USE_EXTERNAL_EMOJIS; the server enforces it.
    ...externalGroups.map((g) => ({
      key: `server-${g.server_id}`, label: g.server_name, icon: g.server_icon ? { src: g.server_icon } : '🌐',
      entries: g.emojis.map((e) => ({ id: e.id, name: e.name, url: e.url, custom: true }))
    })),
    ...emojiCategories().map((c) => ({
      key: c.key, label: c.label, icon: c.icon, entries: c.emojis.map((char) => ({ char }))
    }))
  ]), [recent, customEmojis, externalGroups, locale]);

  const visible = searchResults ?? categories.find((c) => c.key === activeCategory)?.entries ?? [];
  useEffect(() => { setCursor(0); }, [query, activeCategory]);

  const focusCell = (index) => {
    const next = Math.max(0, Math.min(visible.length - 1, index));
    setCursor(next);
    requestAnimationFrame(() => gridRef.current?.querySelector(`[data-cell="${next}"]`)?.focus());
  };

  // Arrow keys move through the grid (rows of 9); ↓ from the search box
  // enters it, ↑ from the first row goes back to the search box.
  const onGridKeyDown = (e) => {
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
    if (e.key in moves) {
      e.preventDefault();
      if (e.key === 'ArrowUp' && cursor < COLUMNS) { searchRef.current?.focus(); return; }
      focusCell(cursor + moves[e.key]);
    } else if (e.key === 'Home') { e.preventDefault(); focusCell(e.ctrlKey ? 0 : cursor - (cursor % COLUMNS)); }
    else if (e.key === 'End') { e.preventDefault(); focusCell(e.ctrlKey ? visible.length - 1 : cursor - (cursor % COLUMNS) + COLUMNS - 1); }
  };

  const labelOf = (entry) => (entry.custom ? `:${entry.name}:` : shortcodeLabel(entry.char));
  const rows = [];
  for (let i = 0; i < visible.length; i += COLUMNS) rows.push(visible.slice(i, i + COLUMNS));

  return (
    <div
      role="dialog"
      aria-label={t('emoji.pickerTitle')}
      className={`bg-d-surface border border-d-edge rounded-lg shadow-2xl w-[min(340px,calc(100vw-1rem))] max-h-[min(24rem,calc(100dvh-1rem))] flex flex-col overflow-hidden ${anchorClass}`}
    >
      <div className="p-2 border-b border-d-edge flex items-center gap-2">
        <div className="relative flex-1">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && visible.length) { e.preventDefault(); focusCell(0); }
              if (e.key === 'Enter' && visible[0]) { e.preventDefault(); pick(visible[0]); }
            }}
            placeholder={t('emoji.search')}
            aria-label={t('emoji.search')}
            className="w-full bg-d-base text-sm max-sm:text-base text-d-strong placeholder-d-text3 px-2 py-1.5 pr-7 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand"
          />
          <Search className="w-3.5 h-3.5 text-d-text3 absolute right-2 top-2.5" aria-hidden="true" />
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="text-d-text3 hover:text-d-strong w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded" aria-label={t('common.close')}>
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Category strip */}
      {!searchResults && (
        <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-d-edge" role="tablist" aria-label={t('emoji.categories')}>
          {categories.map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={activeCategory === c.key}
              aria-label={c.label}
              onClick={() => { setActiveCategory(c.key); scrollRef.current?.scrollTo({ top: 0 }); }}
              title={c.label}
              className={`shrink-0 w-8 h-8 rounded flex items-center justify-center text-base transition-colors ${
                activeCategory === c.key ? 'bg-d-active' : 'hover:bg-d-hover'
              }`}
            >
              {c.key === 'recent' ? <Clock className="w-4 h-4 text-d-text2" />
                : c.key === 'custom' ? <Star className="w-4 h-4 text-d-idle" />
                : c.icon?.src ? <img src={proxiedImageUrl(c.icon.src)} alt="" className="w-5 h-5 rounded-full object-cover" />
                : c.icon}
            </button>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="h-56 min-h-0 flex-1 overflow-y-auto p-2">
        <p className="text-[11px] font-bold text-d-text3 uppercase mb-1.5 sticky top-0 bg-d-surface py-0.5" id="emoji-grid-label" aria-live="polite">
          {searchResults
            ? t('emoji.searchResults', { count: visible.length })
            : categories.find((c) => c.key === activeCategory)?.label}
        </p>

        {visible.length === 0 && (
          <p className="text-xs text-d-text3 py-4 text-center">
            {activeCategory === 'recent' ? t('emoji.noRecent') : t('emoji.notFound')}
          </p>
        )}

        <div ref={gridRef} role="grid" aria-labelledby="emoji-grid-label" onKeyDown={onGridKeyDown} className="flex flex-col gap-0.5">
          {rows.map((row, r) => (
            <div role="row" key={r} className="grid grid-cols-9 gap-0.5">
              {row.map((entry, c) => {
                const i = r * COLUMNS + c;
                return (
                  <span role="gridcell" key={entry.custom ? `c-${entry.id}` : `u-${entry.char}-${i}`}>
                    <button
                      type="button"
                      data-cell={i}
                      tabIndex={i === cursor ? 0 : -1}
                      onClick={() => pick(entry)}
                      onFocus={() => setCursor(i)}
                      title={labelOf(entry)}
                      aria-label={labelOf(entry)}
                      className="w-8 h-8 rounded hover:bg-d-active focus-visible:bg-d-active flex items-center justify-center text-xl transition-transform hover:scale-110"
                    >
                      {entry.custom
                        ? <img src={proxiedImageUrl(entry.url)} alt="" className="w-6 h-6 object-contain" loading="lazy" />
                        : <span aria-hidden="true">{entry.char}</span>}
                    </button>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
