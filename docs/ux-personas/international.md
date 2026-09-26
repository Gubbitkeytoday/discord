# UX persona panel: international group (ja, ru, ko, de, zh-TW, pl, plus a Thai friend)

## สรุปภาษาไทย

เราทดสอบแอปกับผู้ใช้จำลอง 6 คนที่ใช้แอปเป็นภาษาของตัวเอง ได้แก่ ญี่ปุ่น รัสเซีย เกาหลี เยอรมัน จีนตัวเต็ม (ไต้หวัน) และโปแลนด์ และมีเพื่อนคนไทยอีก 1 คน ทุกคนคุยกันในเซิร์ฟเวอร์เดียวที่มีหลายภาษาปนกัน ภาษาของแอปเลือกจากภาษาของเบราว์เซอร์ตั้งแต่เปิดครั้งแรก

**จุดแข็ง:** ตรวจจับภาษาได้ถูกต้องตั้งแต่หน้าล็อกอิน คำแปลส่วนใหญ่อ่านเป็นธรรมชาติ ใกล้เคียงกับที่ Discord ใช้ รูปพหูพจน์ของรัสเซียและโปแลนด์ครบ (one/few/many) รูปแบบวันที่และเวลาตรงตาม locale (ไทยใช้ พ.ศ. 2569 ได้ถูกต้อง) การค้นหาข้อความภาษาญี่ปุ่น เกาหลี จีน ไทย และโปแลนด์ (แม้พิมพ์ตัวเล็กตัวใหญ่ต่างกัน เช่น źdźbło กับ Źdźbło) ใช้ได้ทั้งหมด ชื่อช่องภาษารัสเซียแปลงเป็น slug ได้สวย (#обсуждение-макетов)

**ปัญหาหลัก:**
1. **(S2) ฟอนต์ในแอปไม่ใช่ฟอนต์ที่ตั้งใจ** เพราะ `App.jsx` ใส่คลาส `font-sans` ของ Tailwind ซึ่งทับ `Inter, Kanit` ที่ตั้งไว้บน body ทำให้หน้าล็อกอินใช้ Inter แต่พอเข้าแอปแล้วกลายเป็นฟอนต์ระบบ Kanit (ฟอนต์ไทยที่ bundle มา) จึงไม่ถูกใช้เลย บนเครื่องที่ไม่มีฟอนต์ไทย ข้อความไทยจะเป็นฟอนต์บิตแมป Unifont ที่แตกเป็นพิกเซล (ดูภาพของ Ji-woo และ Wei)
2. **(S2) ชื่อหมวดและชื่อช่องเริ่มต้นเป็นภาษาอังกฤษเสมอ** ("TEXT CHANNELS", "general", "General Voice") เพราะฝังไว้ใน `services/guilds.js` ขณะที่ Discord ตั้งชื่อตามภาษาของผู้สร้างเซิร์ฟเวอร์
3. **(S2) ข้อความ CJK ไม่มีแอตทริบิวต์ `lang` และไม่มี font stack แยกตามภาษา** ตัวอักษรญี่ปุ่นจึงแสดงเป็นรูปแบบจีน (Han unification)
4. **(S3) ข้อความถูกตัด** ในภาษาเยอรมัน ("Einstellungen durchsuche", "Benachrichtigungseinste…") ในภาษาญี่ปุ่น ("すべてのチャンネ,") และในชื่อเซิร์ฟเวอร์ยาวบนหัวข้อ dialog เชิญเพื่อน รวมถึงลิงก์เชิญที่ถูกตัดจนมองไม่เห็นโค้ด
5. **(S3) ข้อความ "นี่คือจุดเริ่มต้นของช่อง" แสดง Markdown ดิบ** (`**ตัวหนา**`, `||สปอยล์||`) ในทุกภาษา
6. **(S3) พหูพจน์ในหน้า Insights ไม่ทำงาน** เพราะส่ง `{n}` แทน `{count}` ภาษารัสเซียจึงได้ "Последние 7 дн." แทน "Последние 7 дней"
7. **(S3) ปุ่มแปลข้อความ (TranslateButton) ยังไม่ได้ต่อเข้ากับ UI** ถึงแม้ backend `/api/translate` จะพร้อมแล้ว และคีย์ `translate.*` กับ `passkeys.*` ยังไม่มีคำแปลในทั้ง 6 ภาษา
8. **(S3) หน้า Roles บนมือถือบีบเป็น 2 คอลัมน์** ภาษาญี่ปุ่นตัดบรรทัดกลางคำ ("チャンネルを|見る")

คะแนนเฉลี่ย: ความประทับใจแรก 7.3 ใช้งานง่าย 7.2 ความสวยงาม 6.2 ความน่าเชื่อถือ 7.0 อยากแนะนำ 6.5 (เต็ม 10)

---

## Method

- Build: branch `worktree-agent-a6e4a44f8f168d1e2` with `claude/dreamy-goldberg-p3o5ao` merged; `npm ci && npm run build`; server started as `scripts/e2e/run.mjs` does (`SERVE_STATIC=1`, throwaway `DB_PATH`/`STORAGE_ROOT`, `ALLOW_DEV_IDENTITY=0`) on port **7060**, and stopped by PID afterwards.
- Scenario scripts (reusable, all label lookups come from `src/i18n/locales/<code>.js` so they do not depend on wording):
  - `scripts/ux/international.mjs`: all 7 users register cold; Dmitri creates the server; everyone joins through the invite link; mixed-language conversation; non-Latin search; message hover/context menu; every User settings tab; Server settings tabs (owner). It also runs an **automatic clipped-text audit** (`scrollWidth > clientWidth` under `overflow:hidden` or ellipsis), an **English-leftover detector** (visible text equal to an English source string), and a **CDP font probe** (`CSS.getPlatformFontsForNode`) that reports which font files actually painted the glyphs.
  - `scripts/ux/international-mobile.mjs`: phone flows (search, long-press, settings through the drawer).
  - `scripts/ux/international-owner.mjs`: each persona creates their own server with a long native name and walks every Server settings page.
  - `scripts/ux/international-langsearch.mjs`: "where do I change the language?" typed into Settings search in each language.
- The locale comes from the browser (`navigator.languages` plus `Accept-Language`), the way a real first visit works. Each persona also has the correct time zone.
- Screenshots are in `/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots/persona-international-*.png`. The paths below omit that directory.
- Environment caveat: the test Chromium only has DejaVu/Liberation, WenQuanYi Zen Hei, IPAGothic, Loma (Thai) and Unifont as system fonts. That is close to a stock Linux or cheap Android build. On macOS, iOS and Windows the system fallbacks look better, but the **root causes below apply everywhere**, because the app's own web fonts are never used after login.

## Personas

| | Profile | Device / setup | Language needs | Apps they know | Goal |
|---|---|---|---|---|---|
| **Yuki** 佐藤ゆき | 26, woman, office worker (accounting) in Tokyo; medium tech literacy; uses her phone for everything | Android, 412×915 @2.625x, Asia/Tokyo | ja only; expects Japanese glyph forms and LINE-like polish | LINE, Instagram, Slack at work | Join her team's server from a link, chat, find "会議" later |
| **Dmitri** Дмитрий Соколов | 38, man, freelance brand/type designer in Moscow; high tech literacy; **very picky about typography** | macOS-like desktop 1440×900 @2x, Europe/Moscow | ru; notices every font switch, kerning, stray asterisks | Telegram, Figma, Discord, Behance | Run a design club server, create a Cyrillic-named channel, invite people |
| **Ji-woo** 김지우 | 19, woman, CS student in Seoul; high tech literacy, impatient | iPhone-class 390×844 @3x, Asia/Seoul | ko | KakaoTalk, Discord, Instagram | Study group chat, search "스터디" |
| **Hans** Hans Müller (DL1ABC) | 60, man, retired engineer running an amateur-radio club; medium-low tech literacy; reads slowly, dislikes truncation and jargon | 1280×720 laptop @1.25x (≈1600×900 at 125%), Europe/Berlin | de; long compound words; call sign in his name | e-mail, WhatsApp, Thunderbird | Set up a club server with a long official name, post the net schedule |
| **Wei** 陳偉 | 33, man, product manager in Taipei; high tech literacy | desktop 1920×1080 @1x, Asia/Taipei | zh-TW; must never see Simplified-Chinese forms; expects 上午/下午 times like LINE | LINE, Messenger, Slack | Organise a night-market food club |
| **Olga** Olga Wiśniewska | 45, woman, teacher and village-association organiser; medium tech literacy | 1366×768 laptop @1x, Europe/Warsaw | pl; diacritics (ą ę ź ż ł), 3 plural forms | Messenger, WhatsApp | Join friends' server, search a word with diacritics |
| **Somchai** สมชาย ใจดี (friend, supporting role) | 30, man, Thai; mixes Thai, English and Japanese in one message | Android 412×915, Asia/Bangkok | th; stacked vowels and tone marks (ปิ๊ป ป๊อป ก๋วยเตี๋ยว) | LINE | Provide the Thai + Japanese + English mixed conversation |

## Task results

Times are wall-clock Playwright times including UI waits. Clicks and taps are the minimum path a human takes.

| Task | Yuki ja 📱 | Dmitri ru 🖥 | Ji-woo ko 📱 | Hans de 💻 | Wei zh-TW 🖥 | Olga pl 💻 | Severity of worst issue |
|---|---|---|---|---|---|---|---|
| Cold start: app appears in own language | ✅ 0 clicks | ✅ | ✅ | ✅ | ✅ | ✅ | none. Detection is correct |
| Register | ✅ 8.0 s, 4 taps | ✅ 9.5 s | ✅ 7.5 s | ✅ 6.4 s | ✅ 6.0 s | ✅ 5.3 s | S4 (Hans: rate limit when the whole club registers from one IP, see #14) |
| Create server with native name | ✅ | ✅ 12.9 s, 4 clicks | ✅ | ✅ | ✅ | ✅ | S3: name truncated in invite title; default channels in English |
| Create channel with non-Latin name | n/t | ✅ 5.4 s; `Обсуждение макетов` → `#обсуждение-макетов` | n/t | n/t | n/t | n/t | none. Nice slug preview |
| Join from invite link | ✅ 4.7 s, 1 tap, but lands in the drawer, not the chat | (owner) | ✅ 5.1 s | ✅ 4.5 s | ✅ 4.4 s | ✅ 3.8 s | S4 |
| Send message in own script | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | none |
| Read mixed Thai + Japanese + English chat | ⚠️ Japanese shown with Chinese glyph forms | ⚠️ font differs from login | ❌ Thai rendered as pixelated bitmap (Unifont) | ⚠️ | ❌ Thai bitmap | ⚠️ | **S2** fonts |
| Search non-Latin (会議 / макет / 스터디 / Funkrunde / 夜市 / źdźbło / ก๋วยเตี๋ยว) | ✅ 1 hit | ✅ 1 hit | ✅ 1 hit | ✅ 1 hit | ✅ 1 hit | ✅ 1 hit (case-insensitive with diacritics) | S4: no match highlighting; S3: search filter truncated in ja |
| Find language setting via Settings search | ✅ but it lives under "テーマ" (Theme) | ✅ "Внешний вид" | ✅ "디스플레이" | ⚠️ 3 hits including "Sprache & Video" | ✅ | ✅ | S3 (de ambiguity) |
| Walk all User settings tabs | ✅ via drawer (≈15 s) | ✅ 18 s | ✅ | ⚠️ search placeholder clipped | ✅ | ✅ | S3 |
| Walk all Server settings tabs as owner | ⚠️ Roles unreadable on phone | ✅ | ⚠️ same | ⚠️ dropdown item clipped | ✅ | ✅ | S3 |
| Translate a foreign-language message | ❌ no button | ❌ | ❌ | ❌ | ❌ | ❌ | S3: `TranslateButton` not wired into the UI |

## Ranked issues

### S2: Major

**#1 Web fonts never apply inside the app: Inter/Kanit only on the login screen.**
- What happened: on the login screen the CDP font probe reports `Inter` (Cyrillic + Latin subsets load, HTTP 200). After login, **0 glyphs** anywhere are painted with Inter or Kanit. Messages and chrome fall back to the OS font (`Liberation Sans` here, SF on macOS, Segoe on Windows, Roboto on Android). Thai therefore never gets the bundled Kanit: in ko and zh-TW contexts the fallback chain lands on **Unifont bitmap glyphs** (visibly pixelated "สมชาย ใจดี", "ผมพูดไทย").
- Screenshots: `persona-international-dmitri-01-login-cold-start.png` (Inter) vs `persona-international-dmitri-03-home-after-register.png` (system font); `persona-international-jiwoo-07-mixed-language-chat.png` and `persona-international-wei-09-message-context-menu.png` (Thai bitmap).
- Who: everyone, and Dmitri most of all: "The login is set in Inter and the moment I'm in, it's a different typeface. The first screen is a lie."
- Root cause: `src/App.jsx:2123`: `<div className="flex h-screen w-screen … font-sans antialiased">`. Tailwind's `font-sans` resets `font-family` to `ui-sans-serif, system-ui, sans-serif…`, overriding `body { font-family: 'Inter', 'Kanit', sans-serif }` in `src/index.css:203`.
- Fix: drop `font-sans` from that div, **or** define the theme token once in `src/index.css`:
  ```css
  @theme { --font-sans: 'Inter', 'Kanit', system-ui, -apple-system, 'Segoe UI', Roboto,
           'Hiragino Sans', 'Yu Gothic UI', 'Apple SD Gothic Neo', 'Malgun Gothic',
           'PingFang TC', 'Microsoft JhengHei', 'Noto Sans CJK JP', sans-serif; }
  ```
  and use `font-family: var(--font-sans)` on `body`. Add a CI check that `getComputedStyle(document.querySelector('[id^=message-]')).fontFamily` starts with `Inter`.

**#2 Default categories and channels are always English.**
- What happened: every new server gets `TEXT CHANNELS / #general / VOICE CHANNELS / General Voice`, whatever the creator's locale. A Japanese office team, a German radio club and a Polish village association all start with English scaffolding. The UI around it is fully translated, so the English stands out.
- Screenshots: `persona-international-yuki-05-after-join.png`, `persona-international-somchai-05-after-join.png`, `persona-international-hans-09-owner-ss-settings-roles.png` (sidebar).
- Yuki: "Why is it English? Did I join a foreign server?" Hans: "What is 'General Voice'? Is that a general?"
- Root cause: hard-coded names in `services/guilds.js:23` (`DEFAULT_CATEGORY_NAMES`) and `:362-365` (the `INSERT … 'TEXT CHANNELS' … 'general' … 'General Voice'`).
- Fix: let `CreateServerModal.jsx` send `defaults: { textCategory: t('defaults.textCategory'), general: t('defaults.general'), voiceCategory: t('defaults.voiceCategory'), generalVoice: t('defaults.generalVoice') }`, or have the server read the creator's `users.locale`. Use Discord's own localisations: ja `テキストチャンネル / 一般 / ボイスチャンネル / 一般`; ru `ТЕКСТОВЫЕ КАНАЛЫ / основной / ГОЛОСОВЫЕ КАНАЛЫ / Основной`; ko `채팅 채널 / 일반 / 음성 채널 / 일반`; de `TEXTKANÄLE / allgemein / SPRACHKANÄLE / Allgemein`; zh-TW `文字頻道 / 一般 / 語音頻道 / 一般`; pl `KANAŁY TEKSTOWE / ogólny / KANAŁY GŁOSOWE / Ogólny`; th `ช่องข้อความ / ทั่วไป / ช่องเสียง / ทั่วไป`. The slugifier already handles non-Latin names.

**#3 No per-language CJK font stack and no `lang` on message content (Han unification).**
- What happened: with `<html lang="ja">` the Japanese UI chrome gets a CJK font, but Japanese message text was painted by WenQuanYi Zen Hei, a Chinese font (probe: `messages: WenQuanYi Zen Hei 62 glyphs`), even though a Japanese font (IPAGothic) is installed. In the mixed chat, Wei's Traditional-Chinese message and Yuki's Japanese message get the same glyph shapes whatever the viewer's UI language, so either Wei or Yuki always sees "foreign" forms (e.g. 直, 骨, 次).
- Screenshot: `persona-international-yuki-07-mixed-language-chat.png`.
- Yuki: "The kanji look slightly Chinese. It feels like a cheap overseas app."
- Root cause: no `:lang()` font rules in `src/index.css` (only `:lang(th)` letter-spacing fixes exist), and message bodies in `src/components/ChatArea.jsx` carry no `lang`.
- Fix: in `src/index.css` add
  `:lang(ja){font-family:'Inter','Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic UI',Meiryo,'Noto Sans JP',sans-serif}`
  `:lang(ko){…'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR'…}`
  `:lang(zh-TW){…'PingFang TC','Microsoft JhengHei','Noto Sans TC'…}`
  `:lang(zh-CN){…'PingFang SC','Microsoft YaHei','Noto Sans SC'…}`.
  In `ChatArea.jsx`, set `lang` on each message body with a cheap script sniff: kana → `ja`, hangul → `ko`, Thai → `th`, Han-only → the author's `locale` (already stored on the account).

### S3: Minor but visible

**#4 German and Japanese strings truncated.** (automatic audit plus screenshots)
| Where | Text | Screenshot | Fix |
|---|---|---|---|
| Settings search (de, 1280 px) | "Einstellungen durchsuche" (placeholder clipped) | `persona-international-hans-15-user-settings-settings-appearancetab.png` | de `settings.searchPlaceholder` → **"Suchen"** |
| Server dropdown (de) | "Benachrichtigungseinste…" (169/198 px) | `persona-international-hans-22-server-dropdown.png` | de `server.notificationSettings` → **"Benachrichtigungen"** (Discord DE uses this), and let `ServerDropdown.jsx` items wrap to 2 lines instead of `truncate` |
| Search filter (ja, phone) | "すべてのチャンネ," | `persona-international-yuki-06-m-long-press.png` | ja `search.allChannels` → **"全チャンネル"**; in `SearchResultsPanel.jsx`, give the `<select>` `min-w-0 flex-1` instead of a fixed width |
| Invite dialog title (all) | "Пригласить друзей на сервер Международн…", "Freunde zu Amateurfunkclub Ortsverband Süd-Württe…" | `persona-international-dmitri-06-invite-offer.png` | `InviteModal.jsx:66`: replace `truncate` with `line-clamp-2 break-words`; the server name is the most important word in that sentence |
| Invite link field (all, 1440 px) | `http://localhost:7060/invite/`: **the invite code itself is cut off** | `persona-international-dmitri-06-invite-offer.png` | `InviteModal.jsx:81`: `text-sm`, scroll the field to its end on focus (`el.scrollLeft = el.scrollWidth`), or show only `…/invite/XRrZ4THN` |
| Channel-list header (all) | "Международный клуб 🌏 国際 국" clipped mid-glyph and the dropdown ✕ overlaps the last glyph | `persona-international-hans-22-server-dropdown.png` | `ChannelSidebar.jsx` header: `min-w-0 truncate` on the name span and `shrink-0` on the chevron/✕ |

**#5 Channel intro shows raw Markdown syntax in every language.** "…включая \*\*жирный текст\*\*, ||спойлеры|| и блоки кода." Dmitri: "Asterisks in a welcome message? Did someone forget to render this?" Screenshot `persona-international-dmitri-08-channel-created.png`. Root cause: `chat.channelStart` is rendered as plain text. Fix: either render the examples through the Markdown renderer in `ChatArea.jsx` (so they look **bold** and spoiler), or make the copy Discord-like and drop the syntax: en "This is the start of the #{channel} channel.", ja "#{channel}チャンネルの始まりです。", ko "#{channel} 채널의 시작이에요.", zh-TW "這是 #{channel} 頻道的起點。", ru "Это начало канала #{channel}.", de "Das ist der Anfang des Kanals #{channel}.", pl "To początek kanału #{channel}.".

**#6 Plural forms in Server Insights never used.** `src/components/settings/InsightsTab.jsx:131,176,194` call `t('insights.lastDays', { n })`. Plural selection in `src/i18n/index.jsx:147` only triggers on `count`, so ru shows the abbreviation fallback "Последние 7 дн." and "Сообщений: 12" instead of the (already translated) "Последние 7 дней" / "12 сообщений". Screenshot `persona-international-dmitri-38-server-settings-settings-insights.png`. Fix: pass `{ count: w }` and rename `{n}` → `{count}` in `insights.lastDays*`, `insights.messagesCount*`, `insights.authorsCount*` in all locale files. The same screen prints chart axis dates as `08-28` / `09-26` (`d.day.slice(5)`, lines 89/93); use `Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short' })` so ru gets "28 авг." and ja "8月28日".

**#7 Message translation is not reachable.** `src/translation/TranslateButton.jsx` + `TranslatedText.jsx` exist, and `routes/translation.js` is mounted (`/api/translate/config` answers 401 when not logged in), but nothing in `src/components` imports them. In a 7-language server that is the feature everyone wanted. Olga: "Hans writes in German all the time, I just want a Translate button like in Messenger." All `translate.*` keys (11) and `apiError.TRANSLATION_*` / `NOTHING_TO_TRANSLATE` / `INVALID_LANGUAGE` are also missing in ja/ru/ko/de/zh-TW/pl, so the button would appear in English. Fix: render `<TranslateButton message={msg}/>` in the hover bar and the mobile long-press sheet of `ChatArea.jsx` (next to Reply/React), and `<TranslatedText>` under the body. Translations below.

**#8 Server Settings → Roles is unreadable on phones.** At 412 px the role list and the permission editor stay side by side. The permission column is about 160 px, and Japanese breaks mid-word ("チャンネルを｜見る", "スタ｜ンプの管理"); every description wraps to 4–5 lines. The ✕ also overlaps the horizontal tab strip ("絵文"). Screenshot `persona-international-yuki-09-owner-ss-settings-roles.png`. Fix in `ServerSettingsModal.jsx` roles pane: `flex-col md:flex-row` (list on top, editor below, like Discord mobile), and add `:lang(ja),:lang(zh-TW),:lang(ko){ word-break: keep-all; line-break: strict; }` for headings in `src/index.css`. Move the close button out of the tab strip, or add right padding equal to its width.

**#9 "Sprache & Video" means "Language & Video" to Hans.** Searching Settings for "Sprache" returns Darstellung, Barrierefreiheit **and Sprache & Video**, and Hans opened the voice tab looking for the language. Language actually lives under Appearance (ja: "テーマ" = *Theme*). Screenshot `persona-international-hans-04-settings-search-language.png`. Fix: de `settings.voiceTab` → **"Sprachchat & Video"**, and add a dedicated **Language** entry in `UserSettingsModal.jsx` (Discord has its own "Language" page), keeping `LanguageList` from `src/i18n/LanguagePicker.jsx`.

**#10 12/24-hour clock is forced and inconsistent.** `src/hooks/useUserSettings.js:62` defaults `use24HourClock: true` for everyone, so the chat shows `23:30` while the search panel on the same screen shows `2026年9月26日 下午11:30` (zh-TW) (`persona-international-wei-09-message-context-menu.png`). Fix: default to `undefined` and let `formatTime` in `src/utils/messageGrouping.js:63` omit `hour12` unless the user explicitly chose, so each locale gets its norm (zh-TW/ko 12 h with 上午/下午 or 오전/오후, ja/de/ru/pl 24 h). Apply the same preference in `formatFullTimestamp`.

**#11 Account page shows a legacy discriminator.** "hans_f512c1#4500" / "jiwoo_0f56fbn#3094" (`AccountSecurityTab.jsx:200`). Discord dropped discriminators in 2023; Ji-woo: "What is #3094, do I have to tell people that?" Fix: show `@username` only. Also the de nav "Konto & Sicherheit" and the page title "Konto und Sicherheit" disagree (`settings.accountTab` vs `settings.accountTitle`); use "Konto & Sicherheit" for both.

**#12 Search "from" filter wording.** `search.anyone` reads as "everyone", not "any author": ja "全員", de "Alle", ru "Любой". Proposed: ja **"すべてのユーザー"**, de **"Beliebige Person"**, ru **"Любой автор"**, pl keep "Ktokolwiek" → better **"Dowolna osoba"**.

### S4: Polish

13. **No match highlighting in search results**: users scan a long Thai or Japanese sentence to find why it matched (`persona-international-somchai-05-m-search-results.png`). Wrap hits in `<mark>` in `SearchResultsPanel.jsx`, segmenting with `Intl.Segmenter` for Thai/CJK.
14. **Registration rate limit of 10/hour/IP** (`routes/auth.js:51`) blocked the 4th and 5th personas during setup ("Du machst das zu schnell"). A radio club or classroom registering on one Wi-Fi hits this at the meeting. Consider keying on IP + username, or 30/hour with a CAPTCHA step instead of a hard block.
15. **After joining on a phone you land in the channel drawer**, not the conversation (`persona-international-yuki-05-after-join.png`). Close the drawer and open `#general` after `Accept invite`, as Discord mobile does.
16. **Long German words break without hyphens** ("…begrenzungsüb|erschreitung", `persona-international-yuki-07-mixed-language-chat.png`). Once #3 adds `lang` on messages, add `hyphens: auto` to message bodies.
17. **The home empty state's three CTA buttons wrap unevenly in ru** ("Создать / сервер" on 2 lines next to a wide single-line button, `persona-international-dmitri-03-home-after-register.png`). Use equal-width buttons (`grid grid-cols-3`) or stack on narrow widths.
18. **Passkeys UI (`src/components/settings/PasskeysSection.jsx`) is not mounted anywhere**, and all 26 `passkeys.*` strings plus 10 `apiError.PASSKEY*` keys are missing in the 6 locales. When it ships, it will ship in English.

## Strings that need better translations (exact keys)

| Locale | Key | Current | Proposed | Why |
|---|---|---|---|---|
| de | `settings.searchPlaceholder` | Einstellungen durchsuchen | **Suchen** | clipped at 1280 px |
| de | `server.notificationSettings` | Benachrichtigungseinstellungen | **Benachrichtigungen** | clipped in dropdown; Discord DE |
| de | `settings.voiceTab` | Sprache & Video | **Sprachchat & Video** | "Sprache" = language |
| de | `settings.accountTitle` | Konto und Sicherheit | **Konto & Sicherheit** | match nav label |
| de | `search.anyone` | Alle | **Beliebige Person** | "from: anyone" |
| de | `chat.channelStart` | …inklusive \*\*fett\*\*, \|\|Spoiler\|\| und Codeblöcken. | **Das ist der Anfang des Kanals #{channel}.** | raw Markdown (#5) |
| ja | `search.allChannels` | すべてのチャンネル | **全チャンネル** | clipped on phone |
| ja | `search.anyone` | 全員 | **すべてのユーザー** | reads as "everyone" |
| ja | `settings.appearanceTab` | テーマ | **外観** (or add a separate 言語 tab) | also hosts Language; "Theme" hides it |
| ja | `chat.channelStart` | ここが#{channel}の始まりです — \*\*太字\*\*… | **#{channel}チャンネルの始まりです。** | raw Markdown |
| ru | `insights.lastDays` | Последние {n} дн. | **Последние {count} дней** (+ `_one` "Последний {count} день", `_few` "Последние {count} дня") | abbreviation; plural never used (#6) |
| ru | `insights.messagesCount` / `authorsCount` | Сообщений: {n} / Человек: {n} | use existing `_one/_few/_many` with `{count}` | #6 |
| ru | `dm.noConversations` | Бесед пока нет — нажмите кнопку сообщения рядом с другом | **Здесь пока пусто. Напишите другу — кнопка «Сообщение» в списке друзей.** | literal, unclear "кнопку сообщения" |
| ru | `search.anyone` | Любой | **Любой автор** | ambiguous |
| ru | `chat.channelStart` | …включая \*\*жирный текст\*\*… | **Это начало канала #{channel}.** | raw Markdown |
| ko | `chat.channelStart` | …\*\*굵게\*\*, \|\|스포일러\|\|… | **#{channel} 채널의 시작이에요.** | raw Markdown |
| zh-TW | `chat.reactedBy` | {names} 作出了反應 | **{names} 已回應** | calque of "reacted" |
| zh-TW | `chat.reactedByMore` | {names} 和其他 {count} 人作出了反應 | **{names} 和其他 {count} 人已回應** | same |
| zh-TW | `server.createOwn` | 親自建立 | **自行建立** | "personally build" sounds odd |
| zh-TW | `chat.channelStart` | 這是 #{channel} 的開端——此處支援 Markdown… | **這是 #{channel} 頻道的起點。** | literary "開端" + raw Markdown |
| pl | `search.anyone` | Ktokolwiek | **Dowolna osoba** | "Ktokolwiek" is colloquial |
| pl | `chat.channelStart` | …\*\*pogrubienie\*\*… | **To początek kanału #{channel}.** | raw Markdown |
| all 6 | `translate.translate` | missing (English) | ja 翻訳 · ko 번역하기 · zh-TW 翻譯 · ru Перевести · de Übersetzen · pl Przetłumacz | #7 |
| all 6 | `translate.showOriginal` | missing | ja 原文を表示 · ko 원문 보기 · zh-TW 顯示原文 · ru Показать оригинал · de Original anzeigen · pl Pokaż oryginał | #7 |
| all 6 | `translate.translatedFrom` | missing | ja {language}から翻訳 · ko {language}에서 번역됨 · zh-TW 翻譯自{language} · ru Переведено с языка: {language} · de Übersetzt aus: {language} · pl Przetłumaczono z: {language} | #7 |
| all 6 | `passkeys.*` (26), `apiError.PASSKEY*` (10) | missing | translate before mounting `PasskeysSection` | #18 |

Checked and **correct** (no change): Russian and Polish CLDR plural sets for all 28 plural keys (`_one/_few/_many` present and grammatical, e.g. pl "2 członków", "5 nowych wiadomości"); ja/ko/zh-TW correctly use only `other`; Thai dates use the Buddhist calendar (26 กันยายน 2569); ru "26 сентября 2026 г. в 18:29"; pl "26 września 2026 17:23"; de "26. September 2026 um 17:29"; typing indicators, "(edited)" and pin wording match Discord's own localisations in all six languages; Thai tone marks and stacked vowels (ปิ๊ป ป๊อป ก๋วยเตี๋ยว ผู้ใหญ่ ฤๅษี) were not clipped anywhere, including the `truncate leading-tight` user panel.

## What delighted them

- **Instant, correct language on first visit**, including region-aware zh-TW (not Simplified). Wei: "Finally an app that doesn't give me 简体 first."
- **The language picker on the login screen** shows native names plus English names, is searchable, and has a completeness badge (`persona-international-hans-lang-picker-mobile.png`).
- **Cyrillic channel names**: "Будет создан как #обсуждение-макетов" live preview. Dmitri: "Slack still can't do this properly."
- **Search works in every script**, including case-insensitive Polish diacritics (źdźbło ↔ Źdźbło) and Thai without spaces.
- **Plural-perfect Russian and Polish** where Dmitri and Olga saw them ("1 результат", "1 wynik").
- **Buddhist-era dates for Somchai**, and time zones handled per user (00:30 in Tokyo and Seoul, 22:30 in Bangkok, 17:30 in Berlin for the same message).
- German copy uses the informal "du" consistently, like Discord DE; Korean uses the friendly 해요체, like Discord KR.

## Scores (1–10)

| Persona | First impression | Ease of use | Visual appeal | Trust / safety | Would recommend |
|---|---|---|---|---|---|
| Yuki (ja, phone) | 7 | 7 | 6 | 7 | 6 |
| Dmitri (ru, desktop) | 7 | 8 | 5 | 7 | 6 |
| Ji-woo (ko, phone) | 8 | 7 | 6 | 7 | 7 |
| Hans (de, laptop) | 7 | 6 | 6 | 7 | 6 |
| Wei (zh-TW, desktop) | 8 | 8 | 7 | 7 | 7 |
| Olga (pl, laptop) | 7 | 7 | 7 | 7 | 7 |
| **Average** | **7.3** | **7.2** | **6.2** | **7.0** | **6.5** |

Persona verdicts:
- Yuki: "It's in Japanese, which is good, but the channels are English and the kanji look Chinese. I'd use it if my team did, but I wouldn't suggest it over LINE."
- Dmitri: "The skeleton is good. Fix the typeface after login and the asterisks, and I'll put my club on it."
- Ji-woo: "Fast and it's all Korean. The roles screen on my phone is a wall of text though."
- Hans: "I got my club server set up. 'Sprache & Video' sent me in circles, and half the menu words are cut off."
- Wei: "Traditional Chinese done right. Give me a Translate button for Olga's Polish."
- Olga: "Polish grammar is correct, that's rare! I just want to translate Hans's German."
