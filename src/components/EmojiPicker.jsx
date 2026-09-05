import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Clock, Star, X } from 'lucide-react';
import { t } from '../i18n/index.jsx';

const RECENT_KEY = 'antigravity.recentEmojis';
const RECENT_LIMIT = 24;

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

function loadRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.slice(0, RECENT_LIMIT) : [];
  } catch { return []; }
}

function saveRecent(entry) {
  try {
    const current = loadRecent().filter((e) => JSON.stringify(e) !== JSON.stringify(entry));
    localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...current].slice(0, RECENT_LIMIT)));
  } catch { /* private mode — recents simply do not persist */ }
}

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
  const searchRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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

    // Unicode emoji have no names in this table, so a text query can only match
    // the category label — surface the whole category when that matches.
    const unicode = emojiCategories()
      .filter((c) => c.label.toLowerCase().includes(q) || c.key.includes(q))
      .flatMap((c) => c.emojis.map((char) => ({ char })));

    return [...custom, ...unicode];
  }, [query, customEmojis, externalGroups]);

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
  ]), [recent, customEmojis, externalGroups]);

  const visible = searchResults ?? categories.find((c) => c.key === activeCategory)?.entries ?? [];

  return (
    <div className={`bg-d-surface border border-d-edge rounded-lg shadow-2xl w-[340px] flex flex-col overflow-hidden ${anchorClass}`}>
      <div className="p-2 border-b border-d-edge flex items-center gap-2">
        <div className="relative flex-1">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('emoji.search')}
            className="w-full bg-d-base text-xs text-d-strong placeholder-d-text4 px-2 py-1.5 pr-7 rounded focus:outline-none"
          />
          <Search className="w-3.5 h-3.5 text-d-text4 absolute right-2 top-2" />
        </div>
        {onClose && (
          <button onClick={onClose} className="text-d-text3 hover:text-d-strong p-1" aria-label={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Category strip */}
      {!searchResults && (
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-d-edge overflow-x-auto">
          {categories.map((c) => (
            <button
              key={c.key}
              onClick={() => { setActiveCategory(c.key); scrollRef.current?.scrollTo({ top: 0 }); }}
              title={c.label}
              className={`shrink-0 w-7 h-7 rounded flex items-center justify-center text-base transition-colors ${
                activeCategory === c.key ? 'bg-d-active' : 'hover:bg-d-hover'
              }`}
            >
              {c.key === 'recent' ? <Clock className="w-4 h-4 text-d-text2" />
                : c.key === 'custom' ? <Star className="w-4 h-4 text-d-idle" />
                : c.icon?.src ? <img src={c.icon.src} alt="" className="w-5 h-5 rounded-full object-cover" />
                : c.icon}
            </button>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="h-56 overflow-y-auto p-2">
        <p className="text-[10px] font-bold text-d-text3 uppercase mb-1.5 sticky top-0 bg-d-surface py-0.5">
          {searchResults
            ? t('emoji.searchResults', { count: visible.length })
            : categories.find((c) => c.key === activeCategory)?.label}
        </p>

        {visible.length === 0 && (
          <p className="text-xs text-d-text3 py-4 text-center">
            {activeCategory === 'recent' ? t('emoji.noRecent') : t('emoji.notFound')}
          </p>
        )}

        <div className="grid grid-cols-9 gap-0.5">
          {visible.map((entry, i) => (
            <button
              key={entry.custom ? `c-${entry.id}` : `u-${entry.char}-${i}`}
              onClick={() => pick(entry)}
              title={entry.custom ? `:${entry.name}:` : entry.char}
              className="w-8 h-8 rounded hover:bg-d-active flex items-center justify-center text-xl transition-transform hover:scale-110"
            >
              {entry.custom
                ? <img src={entry.url} alt={`:${entry.name}:`} className="w-6 h-6 object-contain" />
                : entry.char}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
