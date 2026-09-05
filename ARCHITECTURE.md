# Antigravity Discord — โครงสร้างระบบ (Backend Foundation)

เอกสารนี้อธิบายรากฐานทั้งหมดที่วางไว้ เพื่อให้พัฒนาต่อได้โดยไม่ต้องรื้อ

---

## 1. โครงไฟล์

```
db.js                    connection, promise helpers, transaction, migration runner
db/schema.sql            schema เต็มทุกตาราง (baseline ของ DB ใหม่)
db/seed.js               ข้อมูลตัวอย่างสำหรับ dev

lib/snowflake.js         ID generator แบบ Discord (64-bit, k-sortable)
lib/permissions.js       permission bitfield + การคำนวณสิทธิ์ตาม role/overwrite
lib/mediaProbe.js        magic-byte sniffing + อ่านขนาดรูปจาก header
lib/mediaDuration.js     อ่านความยาว audio/video จาก container (ไม่ใช้ ffmpeg)
lib/httpUtils.js         ApiError, asyncRoute, identify, error handler
lib/auth.js              scrypt + session token
lib/totp.js              TOTP (RFC 6238) สำหรับ 2FA
lib/rateLimit.js         token bucket
lib/mailer.js            console / file / smtp transport
lib/s3Client.js          S3-compatible client + AWS SigV4

storageService.js        ★ storage engine — จุดผ่านของ "ทุกไบต์" ในระบบ
routes/files.js          /api/upload/*, /api/files/* (serve + access control)

services/access.js       ★ ประตูเดียวของสิทธิ์เข้าถึงห้อง — REST และ WebSocket ใช้ตัวเดียวกัน
services/messages.js     อ่าน/เขียนข้อความ, attachment, reaction, mention, search, read state
services/guilds.js       server, role, member, channel, DM, invite, moderation, audit log
services/guildAdmin.js   roles, members, bans, invites, emojis (ฝั่งเขียน)
services/users.js        profile, presence, friend, block, per-user settings
services/userSettings.js ค่าตั้งค่าระดับบัญชี 9 หมวด + validate/clamp (ดูหัวข้อ 23)
services/automod.js      AutoMod + slowmode + timeout
services/webhooks.js     webhook CRUD + execute
services/reports.js      รายงานและการ triage
services/channelPerms.js channel overwrite, sticker, soundboard
services/threads.js      เธรด
services/linkEmbeds.js   link preview + SSRF guard
services/accountSecurity.js  MFA, email verify, password reset

routes/auth.js           /api/auth/*
routes/accountSecurity.js  /api/auth/mfa/*, verify-email, reset-password

realtime.js              Socket.IO gateway (chat, typing, presence, voice, WebRTC signaling)
server.js                composition root เท่านั้น — wiring + mount route
scripts/storage.js       CLI: stats / gc / verify / reindex
scripts/a11y-audit.mjs   ตรวจ accessibility อัตโนมัติ
scripts/jsx-check.mjs    ตรวจโครงสร้าง JSX / import / component ที่ไม่ได้ประกาศ (ไม่ต้องใช้ bundler)
scripts/i18n-audit.mjs   ตรวจว่า key ที่ใช้มีครบทั้ง en/th และไม่มีข้อความไทยฝังในโค้ด
scripts/test*.mjs        integration tests (3 ไฟล์ + harness ร่วม)
```

---

## 2. ที่เก็บรูปภาพและไฟล์ (สิ่งที่ถามถึง)

### 2.1 หลักการ

ไฟล์ **ไม่ถูก "เป็นเจ้าของ" โดยตาราง message หรือ user** — มีตาราง `files` เป็น
ทะเบียนกลาง แล้วสิ่งอื่น *อ้างอิง* เข้ามา นับด้วย `ref_count`

```
files (ทะเบียนกลาง)
  ├── file_variants     thumbnail / ขนาดย่อ / poster
  ├── file_access_log   ใครเปิดไฟล์ private เมื่อไร
  └── ถูกอ้างจาก:  attachments.file_id
                    users.avatar_file_id / banner_file_id
                    servers.icon_file_id / banner_file_id
                    emojis / stickers / soundboard_sounds
```

### 2.2 Content-addressable + dedupe

ชื่อไฟล์บนดิสก์ = `sha256` ของเนื้อไฟล์ อัปโหลดรูปเดิมซ้ำ → ใช้ไฟล์เดิม ไม่กินที่เพิ่ม

```
public/uploads/attachments/3c/ec/3ceccf3a…c8.png          ← ต้นฉบับ
public/uploads/attachments/3c/ec/3ceccf3a…c8.thumb.webp   ← variant
```

แยกโฟลเดอร์ 2 ชั้นจาก prefix ของ hash เพราะโฟลเดอร์เดียวที่มีไฟล์แสนไฟล์
ช้าทุก filesystem

### 2.3 ความปลอดภัย

| ความเสี่ยง | สิ่งที่ทำ |
|---|---|
| ไฟล์ HTML/JS ปลอมเป็น `.png` | `sniffMime()` อ่าน magic bytes จริง ไม่เชื่อ Content-Type จาก client |
| อัปโหลดไฟล์ทำให้ XSS | `X-Content-Type-Options: nosniff` + `CSP: default-src 'none'; sandbox` ทุก response |
| path traversal ใน storage_key | `absolutePath()` บังคับว่าต้องอยู่ใต้ STORAGE_ROOT |
| ไฟล์ใหญ่ถล่มเซิร์ฟเวอร์ | limit ต่อ category ทั้งชั้น multer และชั้น `storeFile()` |
| ผู้ใช้อัปโหลดไม่จำกัด | `users.storage_quota` (default 5 GiB) เช็คก่อนเขียน |
| เขียนไฟล์ค้างกลางทาง | เขียน `.tmp` แล้ว `rename` — atomic |
| ไฟล์ private รั่ว | visibility `public/authenticated/private` + signed URL (HMAC + หมดอายุ) |

### 2.4 Category และ limit

| category | ขนาดสูงสุด | variants |
|---|---|---|
| avatars | 10 MB | thumb 64, small 128, medium 256 (crop สี่เหลี่ยม) |
| banners | 15 MB | small 480, large 1200 |
| icons | 10 MB | thumb 64, small 128 (crop) |
| emojis | 512 KB | thumb 64 |
| stickers | 1 MB | thumb 160 |
| attachments | 50 MB | thumb 200, medium 800 |
| audio / video | 25 / 100 MB | – |

ปรับได้ที่ `CATEGORY_RULES` ใน `storageService.js`
Client เรียก `GET /api/files/limits` มาเช็คก่อนอัปโหลดได้

### 2.5 Thumbnail

ใช้ `sharp` (ติดตั้งแล้ว, อยู่ใน `optionalDependencies`) แปลงเป็น **WebP q82**
ถ้าเครื่องไหนไม่มี sharp ระบบ **ยังอัปโหลดได้ปกติ** แค่ไม่มี thumbnail —
ไม่ล้มทั้งระบบเพราะ native dep

### 2.6 วงจรชีวิตไฟล์ (สำคัญ)

```
upload → ref_count=0  (ยังไม่ผูกกับอะไร)
       → แนบกับข้อความ / ตั้งเป็น avatar → ref_count++
       → ลบข้อความ / เปลี่ยน avatar      → ref_count--
       → ref_count=0 เกิน 24 ชม.         → GC ลบไบต์ทิ้ง
```

จุดที่พลาดได้ง่ายและได้ปิดไว้แล้ว: client เก็บแต่ **URL** ไม่เก็บ file id
→ `findFileByPublicUrl()` แปลง URL กลับเป็น file แล้วนับ ref ให้
(ไม่งั้น avatar ที่ใช้อยู่จะถูก GC ลบ)

### 2.6b GC ผ่าน HTTP — กับดักที่เจอจากการทดสอบจริง

`POST /api/files/maintenance/gc` เคยรับแต่ `dryRun` อย่างเดียว แต่ CLI ใช้คำว่า
`--apply` คนที่เขียน cron ยิง `{"apply": true}` จึงได้ **dry run เงียบ ๆ**
ตอบ 200 พร้อม `removed: 0` — ดูเหมือนทำงานปกติทุกวัน แต่ไม่เคยลบอะไรเลย
ดิสก์เต็มในอีกหลายเดือนถัดมาโดยไม่มีสัญญาณเตือน

อีกจุด: `Number(req.body.orphanGraceMs) || undefined` — **0 เป็น falsy**
สั่ง "เก็บกวาดเดี๋ยวนี้เลย" (grace 0) จึงตกกลับไปใช้ค่า default 24 ชม. เสมอ

แก้แล้วทั้งสองจุด และเพิ่มกติกาว่า:

| สิ่งที่ส่งไป | ผลลัพธ์ |
|---|---|
| `{apply: true}` | ลบจริง |
| `{dryRun: false}` | ลบจริง (ชื่อเดิม ยังใช้ได้) |
| `{apply: true, dryRun: true}` | **400** ขัดกันเอง ไม่เดาให้ |
| `{graceHours: 0}` | grace 0 จริง ๆ |
| `{graceHours: 'soon'}` | **400** |
| ไม่ส่งอะไร | dry run, grace 24 ชม. (ปลอดภัยไว้ก่อน) |

ทุก response มี `effective` บอกว่า **จริง ๆ แล้วรันด้วยค่าอะไร** —
ถ้ามีตั้งแต่แรก บั๊กข้างบนจะถูกจับได้ทันทีที่รันครั้งแรก

และแยกตัวนับให้ตรงความจริง: `removed` / `bytesFreed` = ที่ลบไปจริง (dry run = 0 เสมอ)
ส่วน `wouldRemove` / `wouldFreeBytes` = ที่การรันจริงจะลบ

### 2.6c รูปที่อัปโหลดไปอยู่ไหน — ตรวจจากของจริงแล้ว

ทดสอบกับเซิร์ฟเวอร์ที่รันจริง ไม่ใช่อ่านโค้ดเอา:

```
อัปโหลด avatar
  → POST /api/upload/avatar   (multer field ชื่อ "avatar")
  → sniff magic bytes → ผ่าน → sha256 = 6b7fa434…bcd0
  → เขียนลง  <STORAGE_ROOT>/avatars/6b/7f/6b7fa434…bcd0.png
  → files row: ref_count = 0        ← ยังไม่ผูกกับอะไร
  → คืน { url: "/uploads/avatars/6b/7f/6b7fa434…bcd0.png" }

กด "บันทึก" ในหน้าโปรไฟล์
  → PUT /api/users/user-me { avatar_url }
  → findFileByPublicUrl() แปลง URL กลับเป็น file id
  → ref_count = 1, users.avatar_file_id ผูกไว้    ← GC แตะไม่ได้แล้ว

เปลี่ยนรูปใหม่
  → รูปเก่า ref_count 1 → 0   (รอ GC)
  → รูปใหม่ ref_count 0 → 1
```

ผลตรวจที่ยืนยันแล้ว: bytes ที่เสิร์ฟออกมา **ตรงกับไฟล์ต้นฉบับทุกไบต์**,
อัปรูปเดิมซ้ำได้ไฟล์บนดิสก์ใบเดียว (dedupe), ไฟล์ HTML เปลี่ยนนามสกุลเป็น
`.png` ถูกปฏิเสธด้วย 415, เกินโควตาได้ `QUOTA_EXCEEDED`, emoji เกิน 512 KB ได้ 413,
path traversal ทั้งสามแบบได้ 404, และ signed URL ที่ถูกแก้ signature ได้ 403

**รูปที่โพสต์ในแชทปลอดภัยจาก GC**: `createMessage` เรียก `addReference()`
ต่อไฟล์แนบทุกใบ ทดสอบแล้วว่า sweep ที่ grace = 0 ไม่แตะรูปที่โพสต์ไปแล้ว
และเมื่อลบข้อความ `releaseReference()` คืนค่าเป็น 0 ให้ GC เก็บได้ตามปกติ

### 2.7 คำสั่งดูแล

```bash
npm run storage:stats     # ใช้ไปเท่าไร แยกตาม category / ผู้ใช้
npm run storage:verify    # หา row ที่ไบต์หาย และไบต์ที่ไม่มี row
npm run storage:gc        # dry run
node scripts/storage.js gc --apply --grace-hours 24
```
GC ยังรันอัตโนมัติทุก 6 ชั่วโมงใน `server.js`

---

## 3. ฐานข้อมูล

SQLite + **WAL** (reader ไม่ถูก block ตอนมีคนเขียน), `foreign_keys=ON`,
`busy_timeout=5000` ทุกตารางมี FK ครบและมี index บน read path จริง

45 ตาราง ครอบคลุม:

- **ตัวตน** users, sessions, push_tokens, account_tokens (MFA recovery / verify / reset)
- **ที่เก็บไฟล์** files, file_variants, file_access_log
- **เซิร์ฟเวอร์** servers, roles, server_members, member_roles, bans, invites
- **ห้อง** channels (รวม category / thread / DM / group DM ในตารางเดียว แยกด้วย `type`),
  channel_recipients, channel_overwrites
- **ข้อความ** messages, messages_fts, message_edits, attachments, reactions,
  mentions, pins, link_embeds
- **การแสดงออก** emojis, stickers, soundboard_sounds
- **สังคม** friends, blocks
- **สถานะอ่าน** read_states, channel_settings, server_settings, notifications
- **เสียง** voice_states
- **ระบบอัตโนมัติ/ดูแล** webhooks, audit_logs, automod_rules, reports

### Migration

`db/schema.sql` = baseline (ทุกคำสั่งเป็น `IF NOT EXISTS`)
`MIGRATIONS` ใน `db.js` = การเปลี่ยนแปลงที่ DB เดิมรับจาก schema.sql ไม่ได้
บันทึกใน `schema_migrations` เพิ่ม version ใหม่ต่อท้าย array

DB ตัวเก่า (schema prototype) ถูกตรวจเจอ **สำรองเป็น `discord.db.legacy-*.bak`**
แล้วสร้างใหม่ให้อัตโนมัติ

### กฎเหล็ก: id ของข้อความต้องเป็น snowflake เท่านั้น

ประวัติแชทเรียงและแบ่งหน้าด้วย **id** (ไม่ใช่ `created_at`) เพราะ snowflake
เรียงตามเวลาอยู่แล้วและไม่มีค่าซ้ำ แต่การเปรียบเทียบเป็น **string**
ดังนั้น id ที่ไม่ใช่ตัวเลข เช่น `msg-4` จะเรียง **หลัง** ทุก snowflake
(เพราะ `'m' > '1'`) ผลคือข้อความเก่าไปโผล่ท้ายห้อง และ `?before=` เพี้ยนทั้งหมด

seed ตอนแรกใช้ `msg-1..4` จึงเกิดปัญหานี้จริง — แก้แล้วด้วย
`snowflakeForDate()` (ย้อนเวลา 3 ชม.) และมี **migration v3** ที่แปลง id เก่า
ในฐานข้อมูลที่มีอยู่ พร้อมอัปเดตทุกตารางที่อ้างถึง

> id แบบอ่านออก (`user-me`, `chan-102`, `server-1`) ยังใช้ได้
> เพราะไม่มีที่ไหนเรียงลำดับด้วย id ของตารางเหล่านั้น

### ค้นหาข้อความ — ทำไมใช้ trigram

ภาษาไทยไม่เว้นวรรคระหว่างคำ tokenizer แบบ `unicode61` จะเก็บ
`ทดสอบรูปภาพ` เป็น token เดียว → ค้น `ทดสอบ` **ไม่เจอ**
เปลี่ยนเป็น `tokenize='trigram'` จึงค้นแบบ substring ได้ทุกภาษา
(แลกกับ index ใหญ่ขึ้น และต้องยาว ≥ 3 ตัว — สั้นกว่านั้น fallback ไป `LIKE`)

---

## 4. สิทธิ์ (Permissions)

Bitfield 40 flag แบบ Discord เก็บเป็น decimal string (64-bit ปลอดภัย)
ลำดับการคำนวณตรงตาม Discord:

```
@everyone → union ของทุก role ที่มี → overwrite ของ @everyone
          → overwrite ของ role      → overwrite ของตัวบุคคล
```

- `role id ของ @everyone == server id` (ตามแบบ Discord)
- owner และใครที่มี `ADMINISTRATOR` ได้ทุกสิทธิ์
- ทุก action ที่ต้องกันสิทธิ์เรียกผ่าน `assertPermission()` จุดเดียว
- `GET /api/meta/permissions` ส่ง flag ทั้งหมดให้ client ไปสร้างหน้า role editor

UI เดิมอ่าน `member.role` เป็น `'owner' | 'admin' | 'bot' | 'member'` —
ค่านี้ยังมีอยู่ แต่เป็นค่า **derived** จาก role จริง (ไม่ใช่คอลัมน์)
เช่นเดียวกับ `channel.category` ที่ derive มาจาก `parent_id`
→ UI เดิมทำงานได้ทันที ขณะที่ข้อมูลข้างล่างเป็นของจริง

---

## 5. Realtime

Event เดิมทั้งหมดยังใช้ชื่อและรูปแบบเดิม (client ไม่ต้องแก้) ที่เพิ่ม/แก้:

| หมวด | รายละเอียด |
|---|---|
| `identify` | ผูก socket กับ user, เข้า room `user-<id>` (ส่ง notification ข้ามอุปกรณ์ได้) |
| presence | online เมื่อ socket แรกต่อ, offline เมื่อ socket **สุดท้าย** หลุด (ไม่ใช่แท็บแรกที่ปิด) |
| typing | หมดอายุเองใน 8 วิ — client หลุดกลางทางไม่ทิ้ง "กำลังพิมพ์…" ค้าง |
| voice | เก็บใน `voice_states` (ไม่ใช่ตัวแปรใน memory ที่หายตอน restart), ล้าง state ค้างตอน boot |
| `isSpeaking` | ไม่เขียน DB (เปลี่ยนหลายสิบครั้งต่อวินาที) ส่งเป็น event `voice_speaking` |
| idempotency | `nonce` ต่อข้อความ — ส่งซ้ำเพราะ ack หลุด ไม่เกิดข้อความซ้ำ |
| ack | `send_message` มี callback บอกสำเร็จ/ล้มเหลว |
| WebRTC | server เป็น relay signaling เท่านั้น เสียงวิ่ง peer-to-peer |

---

## 6. API

Endpoint เดิมทั้งหมดยังอยู่ครบ (`/api/users`, `/api/initial-data/:userId`,
`/api/servers/:serverId`, `/api/messages/:channelId`, `/api/upload/*` …)
ที่เพิ่มเข้ามา:

```
GET    /api/health
GET    /api/meta/permissions
GET    /api/files/limits | /api/files/usage | /api/files
GET    /api/files/:id  (+ ?variant=thumb, รองรับ Range สำหรับ audio/video)
POST   /api/files/:id/signed-url
DELETE /api/files/:id
POST   /api/upload/emoji | /api/upload/sticker
GET    /api/search/messages?q=
GET    /api/messages/:channelId/pins        PUT /api/messages/:id/pin
PATCH  /api/messages/:id                    PUT /api/messages/:id/reactions/:emoji
GET    /api/read-states/:userId             POST /api/read-states/:channelId
GET    /api/notifications/:userId
GET/POST /api/dms
POST   /api/servers/:id/roles | /invites | /bans/:userId | /kicks/:userId | /timeouts/:userId
GET    /api/servers/:id/audit-log | /permissions/:userId
POST   /api/invites/:code/accept
PATCH/DELETE /api/channels/:id
POST   /api/friends/requests | /api/blocks
PATCH  /api/servers/:id                      (overview: name, icon, ห้องระบบ, AFK)
DELETE /api/servers/:id                      POST /api/servers/:id/transfer-ownership
GET    /api/servers/:id/roles                PATCH/DELETE /api/servers/:id/roles/:roleId
PUT    /api/servers/:id/roles/order          GET /api/servers/:id/members
PATCH  /api/servers/:id/members/:userId      (ชื่อเล่น)
GET    /api/servers/:id/bans                 DELETE /api/servers/:id/bans/:userId
GET    /api/servers/:id/invites              DELETE /api/servers/:id/invites/:code
GET/POST /api/servers/:id/emojis             DELETE /api/servers/:id/emojis/:emojiId
POST   /api/channels/:id/threads             GET /api/channels/:id/threads
GET    /api/threads/:id                      PATCH /api/threads/:id
POST   /api/threads/:id/join                 DELETE /api/threads/:id/members/me
POST   /api/embeds/resolve                   (link preview, มี SSRF guard)
PUT    /api/settings/channels/:id | /api/settings/servers/:id
```

Pagination ใช้ **snowflake cursor** (`?before=`/`?after=`/`?around=`)
ไม่ใช้ offset เพราะ offset จะซ้ำหรือข้ามข้อความเมื่อมีคนส่งเข้ามาระหว่างเลื่อน

Error ทุกตัวรูปแบบเดียวกัน: `{ error, code, details? }`

---

## 7. ตัวตนผู้ใช้

ดูหัวข้อ 10 — ระบบ authentication จริงใช้งานได้แล้ว

---

## 8. Environment

```
PORT=3001
DB_PATH=./discord.db
STORAGE_ROOT=./public/uploads          # ย้ายออกนอก repo ได้
STORAGE_PUBLIC_BASE=/uploads
STORAGE_URL_SECRET=<เปลี่ยนก่อน production>   # ใช้เซ็น signed URL
CORS_ORIGIN=http://localhost:5173
ADMIN_TOKEN=<ต้องตั้งก่อนใช้ /api/files/maintenance/*>
SQL_DEBUG=1                            # log SQL
```

---

## 9. Frontend

โครงหน้าจอเลียนพฤติกรรม Discord จริง จุดที่ไม่ชัดในตัวโค้ด:

| ไฟล์ | สิ่งที่ควรรู้ |
|---|---|
| `src/utils/messageGrouping.js` | กฎ grouping 7 นาที, date divider, แถบ "ข้อความใหม่" — marker ถูก **freeze** ตอนเปิดห้อง ไม่งั้นแถบจะหายทันทีที่ mark read |
| `src/utils/markdownParser.jsx` | regex เก็บเป็น **source string** ไม่ใช่ RegExp ระดับโมดูล เพราะ `renderInline` เรียกตัวเองแบบ recursive สำหรับ markup ซ้อน — RegExp ที่มี flag `g` จะพา `lastIndex` ข้ามชั้นกันเองแล้ว**ค้างเป็น infinite loop** (เคยเกิดจริง) และ emphasis ต้องมี non-space ติดตัวคั่น ไม่งั้น `2 * 3 * 4` กลายเป็นตัวเอียง, `some_var_name` ก็เช่นกัน |
| `src/components/ComposerAutocomplete.jsx` | ตรวจ trigger `@ # : /` ต้องอยู่ต้นข้อความหรือหลังช่องว่างเท่านั้น — ไม่งั้นอีเมลหรือเวลา `12:30` จะเปิด popup |
| `src/components/ChatArea.jsx` | auto-scroll ทำเฉพาะเมื่อผู้ใช้อยู่ก้นห้อง (`AUTOSCROLL_THRESHOLD_PX`); ตอน prepend ประวัติจะคืนตำแหน่ง scroll ด้วย `prependAnchorRef` |
| `src/App.jsx` | optimistic send ใช้ `nonce` จับคู่ — server ต้องส่ง `nonce` กลับใน payload ไม่งั้นข้อความขึ้นซ้ำสองอัน |
| `src/index.css` + `scripts/themeify.mjs` | สีทั้งหมดเป็น **theme token** (`bg-d-surface`, `text-d-text3`) ไม่ใช่ hex ตรง ๆ เพราะ Tailwind จะฝังค่า hex ลง stylesheet ทำให้สลับธีมไม่ได้ — token ผ่าน CSS variable ที่ `[data-theme=light]` override ได้ (codemod แปลงให้ 623 จุด) |
| `src/hooks/useAppearance.js` | ตอนสลับธีมต้อง **ปิด transition หนึ่งเฟรม** (`.theme-switching`) เพราะ Chromium ไม่ re-resolve `color` ของ element ที่มี `transition-colors` เมื่อมีแค่ CSS variable เปลี่ยน — เคยทำให้ชื่อห้องใน sidebar ค้างเป็นสีของธีมมืด |
| `index.html` | ห้ามใส่คลาสสีลง `<body>` — `bg-[#1e1f22]` ที่นั่นจะ override ธีมสว่างทั้งหมด (เคยเกิดจริง) |
| Threads | thread คือ channel ที่ `type=thread` + `parent_id` → ใช้ `<ChatArea>` ตัวเดียวกัน และ sidebar ซ่อน thread จากการจัดกลุ่ม category แล้วแสดงซ้อนใต้ห้องแม่ |
| Voice | `src/hooks/useVoiceMedia.js` เป็นเจ้าของ stream ทั้งหมด (ไมค์/กล้อง/หน้าจอ) — ถ้าขอ getUserMedia ใน render จะเด้งขออนุญาตซ้ำและ leak track; mute = ปิด `track.enabled` ไม่ใช่ปิด stream เพื่อให้ meter ยังทำงานและ unmute ทันที |
| DM | DM คือ channel ปกติที่ `type='dm'` จึงใช้ `<ChatArea>` ตัวเดียวกับห้องในเซิร์ฟเวอร์ (ส่งเป็น `children` ให้ `HomeDirectMessages`) |

## 10. ตัวตนผู้ใช้และความปลอดภัย

### Authentication

```
POST /api/auth/register      สมัคร (ตรวจชื่อผู้ใช้ + รหัสผ่าน ≥ 8 ตัว)
POST /api/auth/login         เข้าสู่ระบบ → คุกกี้ HttpOnly + Bearer token
POST /api/auth/logout        เพิกถอนเซสชันนี้
POST /api/auth/logout-all    เพิกถอนอุปกรณ์อื่นทั้งหมด
GET  /api/auth/me            ใครกำลังใช้งาน
GET  /api/auth/sessions      รายการอุปกรณ์ที่ล็อกอินอยู่
POST /api/auth/change-password
```

- รหัสผ่านแฮชด้วย **scrypt** (N=16384, r=8) ผ่าน `node:crypto` — ไม่ต้องคอมไพล์
  native dependency และเป็น memory-hard KDF ที่แพลตฟอร์มดูแลให้
- เซสชันเก็บเฉพาะ **sha256 ของ token** ถ้าฐานข้อมูลรั่วก็ replay เป็นการล็อกอินไม่ได้
- คุกกี้เป็น `HttpOnly; SameSite=Lax` → XSS อ่านไม่ได้ และ CSRF ข้ามไซต์ยิง POST ไม่ได้
- **login ที่ผิดใช้เวลาเท่ากับ user ที่ไม่มีอยู่** (verify ปลอมเสมอ) จึงไม่รู้ว่าบัญชีมีจริงไหม
- rate limit ของ login คิดจาก **IP เท่านั้น** เพราะผู้โจมตีเลือก username ได้เอง
- **token ที่ใช้ไม่ได้ → 401 ทันที** ไม่ fallback ไปตัวตนอื่นเงียบ ๆ
- `ALLOW_DEV_IDENTITY=0` ปิดทาง `x-user-id` สำหรับ production

### Rate limiting

Token bucket ในหน่วยความจำ (`lib/rateLimit.js`) — read 600/นาที, write 60/นาที,
upload 30/นาที, login 10 ต่อ 5 นาทีต่อ IP; ล้าง bucket เก่าทุกนาทีกันหน่วยความจำบวม

### AutoMod, slowmode, timeout

รันใน `createMessage()` **ก่อน** เขียนข้อมูล → ข้อความที่ถูกบล็อกไม่เคยมีอยู่
5 trigger: keyword · regex · link (allow-list) · mention_spam · spam
3 action: block · alert · timeout
ยกเว้นตาม role/ห้องได้ และคนที่มี `MANAGE_MESSAGES` ไม่ติดกฎ (ไม่งั้นผู้ดูแลจะติดกฎตัวเอง)

> regex ที่ผู้ใช้ใส่ถูกตรวจก่อน: ยาวเกิน 200 ตัว, มี lookbehind, หรือมี nested
> quantifier แบบ `(a+)+` จะถูกปฏิเสธ — ไม่งั้นกฎเดียวทำให้เซิร์ฟเวอร์ค้างได้

### Webhooks

token คือ credential จึงเก็บเป็นแฮชและ**แสดงครั้งเดียว**ตอนสร้าง
เทียบแบบ constant-time และ webhook ที่ถูกลบตอบเหมือน token ผิด (401)
การ execute ไม่ต้องมีเซสชัน — นั่นคือจุดประสงค์ของมัน

### SSRF guard ของ link preview

`resolveEmbed()` resolve DNS แล้วปฏิเสธทุก private range (10/8, 127/8, 172.16/12,
192.168/16, **169.254/16 ซึ่งคือ cloud metadata**, 100.64/10, IPv6 fc/fd/fe80)
อ่านแค่ 256 KB แรก timeout 5 วิ และแคชผลรวมถึงกรณี fail

---

## 11. Voice (WebRTC)

```
useVoiceMedia   ไมค์ · กล้อง · แชร์หน้าจอ · push-to-talk · ตรวจจับการพูด · เบลอกล้อง
useVoicePeers   full mesh — RTCPeerConnection ต่อ 1 คน
VoiceRoom       ตารางวิดีโอ · pin/stage · ระดับเสียงรายคน · local mute
```

- **full mesh** เหมาะถึงราว 8 คน เพราะ upstream โตเป็นเส้นตรงตามจำนวนคน
  เกินจากนั้นต้องใช้ SFU
- **fixed transceivers**: ตอนสร้าง connection จอง 3 ช่องไว้ล่วงหน้าเสมอ
  `mid 0 = audio, 1 = camera, 2 = screen` แม้ยังไม่มี track จริง ฝั่งรับ
  map track เข้าบทบาทด้วย `transceiver.mid` ไม่ใช่ลำดับที่ track มาถึง
  ทำให้เปิดกล้องกลางสายเป็นแค่ `replaceTrack()` — ไม่ต้อง renegotiate
  และไม่มีทางสลับกล้องกับหน้าจอกันเอง
- **perfect negotiation** แทนกติกา "socket id น้อยกว่าเป็นฝ่าย offer" แบบเดิม:
  ฝั่ง impolite ที่เจอ offer ชน (`ignoreOffer`) จะทิ้ง offer นั้น ส่วนฝั่ง polite
  ยอม rollback — จึงรองรับการเพิ่ม track ระหว่างสายได้โดยไม่ deadlock
- เสียงของแต่ละคนวิ่งผ่าน **GainNode** ไม่ใช่ `<audio>.volume` เพราะ volume
  สูงสุดได้แค่ 1.0 แต่ Discord ให้ดันถึง 200% ค่าที่ได้ยินจริงคือผลคูณของ
  deafen × local mute × ระดับเสียงรายคน × ระดับเสียงรวม × attenuation
- mute = ปิด `track.enabled` ไม่ใช่ปิด stream → meter ยังทำงาน, unmute ทันที,
  และ peer connection ไม่ต้อง renegotiate
- **deafen** ตัดที่ gain ของทุก peer ไม่ใช่แค่ซ่อน UI (ของเดิมไม่ได้ตัดเสียงจริง)
- **เบลอกล้อง** ทำด้วย canvas: `video → ctx.filter = blur(Npx) → canvas.captureStream()`
  แล้วส่ง track ของ canvas แทน ไม่ต้องโหลดโมเดล ML และไม่ต้องพึ่ง CDN
- **automatic sensitivity** ติดตาม noise floor ของห้อง (ลงเร็ว/ขึ้นช้า) แล้วตั้ง
  threshold ไว้เหนือ floor 8 dB แทนการให้ผู้ใช้ตั้งค่าคงที่

**ยืนยันแล้วว่าส่งเสียงได้จริง**: ทดสอบด้วย 2 peer ผ่าน signaling server จริง —
ทั้งคู่ถึงสถานะ `connected`, `ontrack` ยิงทั้งสองฝั่ง, และ RTP ส่งจริง 1,583 bytes
ในแอปเองแสดงตัวบ่งชี้ `P2P 1/1` เมื่อเปิด 2 แท็บเข้าห้องเดียวกัน

---

## 12. MFA, อีเมล และการกู้บัญชี

```
POST /api/auth/mfa/begin       ขอ secret + otpauth URI (ยังไม่เปิดใช้)
POST /api/auth/mfa/confirm     ยืนยันรหัส → เปิด 2FA + ได้ recovery code 10 ชุด
POST /api/auth/mfa/disable     ปิด 2FA (ต้องใส่รหัสหรือ recovery code)
GET  /api/auth/mfa/status
POST /api/auth/verify-email/request | /api/auth/verify-email
POST /api/auth/forgot-password      | /api/auth/reset-password
GET  /api/auth/mail-transport       (บอกว่า transport ไหนทำงานอยู่)
```

**TOTP (RFC 6238)** เขียนเองด้วย `node:crypto` — HMAC-SHA1 บน counter 30 วินาที
ใช้ได้กับ Google Authenticator / Authy / 1Password / Aegis
**ทดสอบกับ test vector ทั้ง 6 ชุดใน RFC** ซึ่งเป็นวิธีเดียวที่รู้ว่า interop จริง

จุดออกแบบที่สำคัญ:
- ยังไม่เปิด 2FA จนกว่าจะพิสูจน์รหัสได้ — ไม่งั้นตั้งค่าพลาดแล้วล็อกตัวเองออก
- **ปิด 2FA ก็ต้องใส่รหัส** ไม่งั้น session ที่ถูกขโมยจะถอดปัจจัยที่สองออกเงียบ ๆ
- recovery code เก็บเป็นแฮชและ **ใช้ได้ครั้งเดียว** (ทดสอบว่าใช้ซ้ำไม่ได้)
- ยอมรับรหัสของ window ข้างเคียง ±30 วิ เพราะนาฬิกาโทรศัพท์คลาดได้
- เทียบรหัสแบบ constant-time

**Mail** (`lib/mailer.js`) เลือก transport ด้วย `MAIL_TRANSPORT`:
`console` (ค่าเริ่มต้น) · `file` (สำหรับ CI) · `smtp` (STARTTLS จริง เขียนบน
`node:net`/`node:tls` ไม่ใช้ nodemailer เพราะต้องการแค่ทางเดียว)
เมื่อไม่ได้ตั้ง transport ระบบคืน `dev_token` มาให้เพื่อทดสอบได้

**Anti-enumeration**: `forgot-password` ตอบ `{sent:true}` เสมอ ไม่ว่าอีเมลมีจริงไหม
และไม่คืน token ให้อีเมลที่ไม่มีในระบบ (ทดสอบว่า response เท่ากัน)

**reset สำเร็จ = เพิกถอนทุก session** เพราะการรีเซ็ตหมายถึง "ฉันเสียการควบคุมบัญชี"

---

## 13. Storage backend: local หรือ S3/R2

`lib/s3Client.js` — เขียน **AWS Signature V4** เอง ไม่ใช้ AWS SDK (SDK กินพื้นที่
~15 MB สำหรับสิ่งที่จริง ๆ คือ PUT/GET/DELETE/HEAD)

**ทดสอบกับลายเซ็นที่ AWS ประกาศไว้ในเอกสารของตัวเอง** — เป็นวิธีเดียวที่รู้ว่า
ลายเซ็นจะถูกยอมรับจริง:
```
f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41  ✓ ตรง
```

รองรับ AWS S3 · Cloudflare R2 · MinIO · Backblaze B2 (path-style และ
virtual-hosted) พร้อม **presigned GET** เพื่อให้เบราว์เซอร์ดึงไฟล์ตรงจาก bucket
โดยไบต์ไม่ผ่านเซิร์ฟเวอร์นี้

สลับ backend ด้วย env เท่านั้น ไม่ต้องแก้โค้ด:
```
S3_ENDPOINT · S3_BUCKET · S3_ACCESS_KEY_ID · S3_SECRET_ACCESS_KEY
S3_REGION (auto) · S3_FORCE_PATH_STYLE (1)
```
ถ้าไม่ครบ → `activeBackend()` คืน `local` และทุกอย่างทำงานเหมือนเดิม

> `uriEncode()` ทำตาม RFC 3986 ไม่ใช่ `encodeURIComponent` เพราะตัวหลังไม่ encode
> `!'()*` ซึ่ง S3 ต้องการ — ทดสอบไว้แล้ว

---

## 14. ความยาวสื่อและ poster

`lib/mediaDuration.js` อ่านความยาว **จากตัว container โดยไม่ใช้ ffmpeg**:
MP4/MOV จาก atom `mvhd` · WebM/MKV จาก Segment Info · MP3 จาก Xing frame
(หรือประมาณจาก bitrate) · Ogg จาก granule position ของหน้าสุดท้าย · WAV จาก
ขนาด data chunk เทียบ byte rate

**poster frame** ต้องมี decoder จริง จึงเรียก ffmpeg แบบ optional เหมือน sharp —
ไม่มี ffmpeg ก็อัปโหลดวิดีโอได้ปกติ แค่ไม่มีภาพปก (มี timeout 10 วินาที
กันไฟล์เสียทำให้ค้าง)

---

## 15. Voice: ขอบเขตของ full mesh

รองรับสูงสุด **8 คนต่อห้อง** (`VOICE_MESH_LIMIT`) เพราะ mesh ทำให้แต่ละคน
ต้องอัปโหลด 1 stream ต่อคนที่เหลือ — bandwidth โตเป็นเส้นตรง

เกินจากนั้นเซิร์ฟเวอร์ **ปฏิเสธการเข้าห้องพร้อมบอกเหตุผล** (`VOICE_FULL`)
ไม่ปล่อยให้คุณภาพเสียงค่อย ๆ แย่ลงแบบไม่มีใครรู้สาเหตุ
ถ้าตั้ง `channels.user_limit` ต่ำกว่านั้น ระบบใช้ค่าที่น้อยกว่า

การรองรับห้องใหญ่กว่านี้ต้องมี **SFU** (media server อย่าง mediasoup/LiveKit)
ซึ่งเป็นคนละสถาปัตยกรรม ไม่ใช่โค้ดที่เพิ่มเข้ามาได้

---

## 16. การทดสอบ

```bash
npm test     # 242 integration tests, 3 ไฟล์รันขนานกัน
npm run a11y # ตรวจ accessibility แบบอัตโนมัติ
```

แต่ละไฟล์เปิดเซิร์ฟเวอร์จริงบนพอร์ตและ DB ชั่วคราวของตัวเอง ไม่แตะ `discord.db`

**ที่ทดสอบกับมาตรฐานภายนอก** (ไม่ใช่แค่ทดสอบว่าโค้ดตรงกับตัวเอง):
- TOTP → test vector ทั้ง 6 ชุดของ RFC 6238
- S3 SigV4 → ลายเซ็นตัวอย่างที่ AWS ประกาศ
- WebRTC → วัด RTP ที่ส่งจริง 1,583 bytes ระหว่าง 2 peer

**Security probes**: SQL injection (path + search) · prototype pollution ·
body ขนาดเกิน · header injection ผ่านชื่อไฟล์ · path traversal 3 รูปแบบ ·
SVG ที่ฝัง script · SSRF (รวม cloud metadata 169.254.169.254) ·
การกันยกระดับสิทธิ์ทั้งระดับ role และระดับห้อง

**Accessibility audit** (`npm run a11y`) ตรวจ accessible name ของทุก control,
ARIA state, alt text และ **WCAG contrast ทั้งธีมมืดและสว่าง** — ปัจจุบันผ่านหมด
(เคยเจอจริง 2 อย่าง: label ที่ไม่ผูกกับ input ใน User Settings และสีลิงก์
`#00a8fc` บนพื้นขาวได้แค่ 2.62:1 จึงเปลี่ยนเป็น `#0068a8` ในธีมสว่าง)

---

## 17. Internationalisation (i18n)

เดิม UI เป็นภาษาไทยฝังในโค้ดทั้งหมด ตอนนี้ย้ายไป dictionary แล้ว **รองรับ th + en
สลับได้ทันทีระหว่างใช้งาน** (Settings → ธีมและการแสดงผล → ภาษา)

**โครงสร้าง** — `src/i18n/`

| ไฟล์ | หน้าที่ |
|---|---|
| `en.js`, `th.js` | dictionary แบบ flat key → string เรียงลำดับ key เหมือนกันทั้งสองไฟล์ เพื่อ diff ง่าย (~495 keys) |
| `index.jsx` | `I18nProvider`, `useI18n`, `useT`, `t`, `localeTag`, `initLocale` |

**ทำไมมี `t()` แบบไม่ใช่ hook** — component ส่วนใหญ่ต้องการแค่ฟังก์ชันแปล
การร้อย hook ผ่าน call site หลายร้อยจุดคือ noise เปล่า ๆ ดังนั้น provider
publish locale ไว้ที่ระดับ module แล้ว **remount subtree ด้วย `key={locale}`
เมื่อเปลี่ยนภาษา** — พอ remount ทุก component จึง re-render และอ่าน locale ใหม่เสมอ
โดยไม่ต้อง subscribe context ทีละตัว (เปลี่ยนภาษาเกิดนาน ๆ ครั้ง ค่า remount ไม่สำคัญ)

**กับดักที่เจอจริง** — constant ระดับ module ที่เรียก `t()` เช่น `const TABS = [...]`
จะถูก evaluate ตอน import ครั้งเดียว **แล้วค้างภาษาแรกที่โหลด** ต่อให้ remount ก็ไม่แก้
จึงเปลี่ยนทุกตัวเป็นฟังก์ชัน (`tabs()`, `permissionGroups()`, `triggers()`,
`emojiCategories()`, `slashCommands()` …) ให้ resolve ตอน render

`permissionCatalog.js` และ `useAppearance.js` เก็บแต่ **key** ไม่เก็บข้อความ —
label/description มาจาก `perm.<NAME>` / `appearance.<key>` ตอน render

**Locale detection** — localStorage → `navigator.languages` → `'en'`
คนเปิดจากประเทศไหนก็ได้ภาษาที่อ่านออกตั้งแต่โหลดครั้งแรก และ `initLocale()`
ตั้ง `<html lang>` ก่อน React mount

**Formatter** ผูกกับ locale: `formatNumber`, `formatDate`, `formatRelative`,
`formatBytes` ใช้ `Intl.*` (`th-TH` / `en-GB`) จุดที่เรียก `toLocaleDateString`
ตรง ๆ เปลี่ยนไปใช้ `localeTag()` แทน `'th-TH'` ที่ hardcode ไว้

**`npm run i18n:audit`** — fail ถ้า key ขาดหายระหว่างภาษา หรือมี `t('key')`
ที่ไม่มีใน dictionary, warn ถ้า placeholder `{name}` ไม่ตรงกัน, และรายงานจำนวน
ข้อความไทยที่ยังฝังในโค้ด (ปัจจุบัน **0**)

**เพิ่มภาษา** — คัดลอก `en.js` → แปล → เพิ่มใน `DICTIONARIES`, `LOCALES`,
`INTL_LOCALE` → รัน audit

---

## 18. Production hardening

| ส่วน | ไฟล์ | ทำอะไร |
|---|---|---|
| Config validation | `lib/config.js` | **ไม่ยอม start** ถ้า `NODE_ENV=production` แล้วเจอ `STORAGE_URL_SECRET` ค่า dev / สั้นกว่า 24 ตัว / `ALLOW_DEV_IDENTITY` เปิด / `CORS_ORIGIN=*` และ warn เรื่อง `SECURE_COOKIES`, `PUBLIC_URL` ที่ไม่ใช่ https, `ADMIN_TOKEN` ที่ไม่ได้ตั้ง |
| Security headers | `lib/middleware.js` | CSP, HSTS (เฉพาะ production), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, COOP, `Permissions-Policy` — ข้าม `/uploads` กับ `/api/files/` ที่มี policy เข้มกว่าอยู่แล้ว |
| Structured logging | `lib/middleware.js` | JSON บรรทัดละ object ใน production มี `request_id` ที่ตอบกลับใน `X-Request-Id` ด้วย เพื่อไล่จาก error ที่ user แจ้งไปหา log ได้ |
| Metrics | `/metrics` | Prometheus text exposition: request count แยก method/status, p50/p95/p99, 5xx, websocket ที่ต่ออยู่, message, upload, memory — ล็อกด้วย `METRICS_TOKEN` ได้ |
| Probes | `/api/live`, `/api/ready` | live ไม่แตะ DB (DB สะดุดไม่ควรทำให้ orchestrator ฆ่า container) · ready แตะ DB และตอบ **503 ทันทีที่เริ่ม drain** |
| Graceful shutdown | `server.js` | SIGTERM → ready เป็น 503 → ปิด socket.io → ปิด http → checkpoint DB ภายใน `SHUTDOWN_TIMEOUT_MS` (15s) แล้วบังคับออก |
| Housekeeping | `server.js` | ทุกชั่วโมง: prune session/token หมดอายุ, archive thread ที่เลย auto-archive |
| SPA serving | `server.js` | `SERVE_STATIC=1` เสิร์ฟ `dist/` จาก process เดียวกัน — asset ที่มี hash ตั้ง `immutable` 1 ปี, `index.html` เป็น `no-cache` (ไม่งั้น deploy แล้ว client ยัง boot bundle เก่า) |

**Deployment artifacts** — `Dockerfile` (multi-stage, non-root, healthcheck),
`docker-compose.yml` (app + Caddy ที่ออก TLS cert ให้อัตโนมัติ), `Caddyfile`,
`nginx.conf.example`, `.dockerignore`, `.env.example` และ `DEPLOYMENT.md`

**Backup** — `scripts/backup.mjs` ใช้ `VACUUM INTO` ของ SQLite เอง ไม่ใช่ `cp`
เพราะการ copy ไฟล์ที่ server เขียนอยู่อาจได้ page ที่ขาดหรือตกข้อมูลที่ยังอยู่ใน WAL
ส่วนไฟล์อัปโหลดเป็น content-addressed จึงคัดลอกแบบเพิ่มเท่านั้น (`verify` เปิดไฟล์
แบบ read-write เพราะ `integrity_check` ของ FTS5 ต้องเขียนได้ ไม่งั้นรายงาน fail
ที่แท้จริงเป็นแค่ปัญหา permission)

`npm run verify` = build + test + a11y + i18n audit ในคำสั่งเดียว

---

## 19. สิ่งที่ทำไม่ได้ในเครื่องนี้

ทั้งหมดต้องการของที่เครื่องนี้ไม่มี ไม่ใช่โค้ดที่ยังไม่ได้เขียน:

| หัวข้อ | ต้องมีอะไร |
|---|---|
| **ทดสอบกับ screen reader จริง** | NVDA (Windows) หรือ VoiceOver (macOS) และคนฟัง — `npm run a11y` ตรวจได้ทุกอย่างที่ตรวจอัตโนมัติได้แล้ว แต่แทนการฟังจริงไม่ได้ |
| **DAST scan (hawkscan)** | `hawk` CLI + StackHawk API key — ติดตั้งด้วย `brew install stackhawk/cli/hawk && hawk init --browser` แล้วสแกนได้ทันที |
| **build image จริงจาก `Dockerfile`** | Docker daemon — Docker Desktop ในเครื่องนี้ไม่ได้รัน (`npipe:////./pipe/dockerDesktopLinuxEngine` ต่อไม่ได้) ตัว `Dockerfile`/`docker-compose.yml`/`Caddyfile` เขียนครบและ review แล้ว แต่ **ยังไม่ได้ build ยืนยันด้วยตาตัวเอง** — เปิด Docker Desktop แล้วรัน `npm run docker:up` |
| **`npm run build` ของ client** | รอบล่าสุดแก้ client ทั้งชุด ตรวจด้วย `npm run jsx:check` + `npm run a11y` + `npm run i18n:audit` ผ่านหมด และ integration test 193 ข้อผ่านหมด แต่ `vite build` ต้องรันบนเครื่องที่ลง native binary ของ esbuild/rollup ได้ — **รัน `npm run verify` หนึ่งครั้งก่อน deploy** |

รวมถึง **SFU** ในหัวข้อ 15 ที่เป็นข้อจำกัดเชิงสถาปัตยกรรม ไม่ใช่งานที่ค้าง


---

## 20. ประตูสิทธิ์เดียว (services/access.js)

เดิมการเช็คสิทธิ์กระจายอยู่ตาม route ทำให้ REST กับ WebSocket ตอบไม่ตรงกัน —
`GET /api/messages/:id` ป้องกันไว้ แต่ `join_channel` บน gateway ไม่ได้เช็ค
ใครเดา id ห้องส่วนตัวถูกก็รับ `new_message` ได้ทั้งห้อง

ตอนนี้ทุกทางเข้าเรียก `assertChannelAccess()` ตัวเดียวกัน:

```
guild channel → ต้องเป็นสมาชิก + VIEW_CHANNEL หลังรวม overwrite + สิทธิ์ที่ระบุ
DM / group DM → ต้องเป็น recipient (และไม่ถูก block ถ้าเป็น action ที่เขียน)
thread        → สืบสิทธิ์จากห้องแม่ และใช้ SEND_MESSAGES_IN_THREADS ตอนส่ง
timeout       → ตอบ TIMED_OUT พร้อมเวลาที่ปลด ไม่ใช่ "ขาดสิทธิ์" ลอย ๆ
```

จุดที่ตามมาด้วยกันทั้งชุด:

| เรื่อง | พฤติกรรมแบบ Discord ที่ทำแล้ว |
|---|---|
| ห้องส่วนตัว | ไม่โผล่ใน channel list, unread badge, search, mention inbox และ room ของ socket |
| timeout | ตัดสิทธิ์เหลือ VIEW_CHANNEL + READ_MESSAGE_HISTORY, สูงสุด 28 วัน, ADMINISTRATOR ยกเว้น, เก็บเป็น UTC เสมอ |
| ลำดับชั้น | แบน/เตะ/พัก คนที่บทบาทสูงกว่าหรือเท่ากันไม่ได้ และแตะเจ้าของไม่ได้ |
| @everyone / @here | นับเป็น mention เฉพาะเมื่อผู้ส่งมี MENTION_EVERYONE — `@here` นับเฉพาะคนออนไลน์ |
| unread | คนที่มองไม่เห็นห้องไม่ได้ unread และไม่ได้ notification (เดิมรั่ว 200 ตัวอักษรแรกของข้อความ) |
| เธรด | แจ้งเฉพาะคนในเธรด และการโพสต์เท่ากับเข้าร่วมเธรดนั้น |
| block | ปิดทั้งการส่ง การรีแอค และการปักหมุดใน DM รวมถึงถูกดึงเข้ากลุ่ม |
| mark as read | ไม่ส่ง messageId = อ่านถึงข้อความล่าสุด (เดิมล้าง pointer ทิ้ง) — mark as unread แยก endpoint |
| rate limit | เส้นทางเขียนจริงมี bucket แล้ว รวมถึง `send_message` บน socket ที่เคยเลี่ยง Express ได้ทั้งหมด |

## 21. Migration v6–v8

| version | ทำอะไร |
|---|---|
| v6 | `messages.sticker_id` — สติกเกอร์หนึ่งดวงต่อข้อความแบบ Discord |
| v7 | `reports.server_id` — ผูกรายงานกับเซิร์ฟเวอร์ เพื่อให้ผู้ดูแลเซิร์ฟเวอร์นั้น triage เองได้ ไม่ต้องใช้ ADMIN_TOKEN ระดับ instance |
| v8 | `user_settings` — ค่าตั้งค่าระดับบัญชี 9 หมวด (ดูหัวข้อ 23) |

`MIGRATIONS` มี guard ตอน import แล้วว่า version ต้องเรียงจากน้อยไปมาก
เพราะ runner ไล่ตามลำดับใน array ไม่ได้ sort ให้

## 22. ตรวจ client โดยไม่มี bundler

`npm run jsx:check` อ่านทุกไฟล์ใน `src/` แล้วตรวจ:

- วงเล็บและ tag JSX สมดุลหรือไม่ (สแกนเอง โดยข้าม string / template / regex / comment
  และรู้ว่า `onChange={(e) => …}` มี `>` อยู่ข้างในไม่ใช่ปิด tag)
- `import` ชี้ไปยังไฟล์ที่มีอยู่จริง
- `<Component>` ทุกตัวถูก import หรือประกาศในไฟล์นั้น

ไม่ได้แทน `npm run build` — แต่จับ error ที่เกิดจริงตอนแก้ไฟล์จำนวนมากได้โดยไม่ต้องต่อ network

---

## 23. User settings (v8)

### 23.1 ที่เก็บ

ตาราง `user_settings` เก็บ **หนึ่งแถวต่อหนึ่งหมวด** ไม่ใช่หนึ่งแถวต่อผู้ใช้:

```sql
user_settings(user_id, category, data JSON, updated_at)
PRIMARY KEY (user_id, category)
```

เหตุผล: แต่ละแท็บของหน้า Settings เขียนคนละหมวด การเขียนพร้อมกันจึงไม่ทับกัน
และ `PATCH` หมวดหนึ่งไม่ต้องอ่าน-เขียน blob ทั้งก้อน

9 หมวด: `appearance` · `accessibility` · `notifications` · `chat` · `privacy` ·
`activity` · `streamerMode` · `keybinds` · `voice`

### 23.2 ค่าเริ่มต้นและการตรวจค่า

`SETTING_DEFAULTS` ใน `services/userSettings.js` เป็นแหล่งความจริงเดียว
แถวใน DB เก็บเฉพาะค่าที่ผู้ใช้เปลี่ยน — อ่านออกมาแล้ว merge ทับ default เสมอ
ทำให้เพิ่ม setting ใหม่ในอนาคตไม่ต้องเขียน migration

`validate()` ทำสองอย่าง:

- **enum** ผิด → โยน 400 (เช่น `theme: 'chartreuse'`)
- **ตัวเลข** นอกช่วง → **clamp** ไม่ใช่ปฏิเสธ (เช่น `zoom: 5` → `50`)

เลือกต่างกันเพราะ enum ผิดแปลว่า client เพี้ยน แต่ตัวเลขเกินช่วงมักมาจาก slider
ที่ range ไม่ตรงกัน — clamp แล้วใช้งานต่อได้ดีกว่าพัง

### 23.3 sync ข้ามแท็บ

```
PATCH /api/settings/preferences/:category
   → เขียน DB
   → io.to(`user-<id>`).emit('user_settings_updated', { category, value })
```

client เก็บ store ระดับ module (`src/hooks/useUserSettings.js`) พร้อม debounce
400 ms ก่อนยิง PATCH — เลื่อน slider รัวไม่ทำให้เกิด request ต่อ pixel
UI อัปเดตทันทีจาก local state ส่วน network เป็น write-behind

`GET /api/settings/me` คืน `preferences` มาพร้อม read-state ตอน boot จึงไม่มี
FOUC ของธีม

### 23.4 การนำไปใช้จริง

`applyPreferences()` เขียนลง `<html>` เป็น `data-*` + CSS custom properties
ไม่ใช่ inline style ราย component:

| preference | ปลายทาง |
|---|---|
| theme | `data-theme="light\|ash\|dark\|onyx"` |
| uiDensity | `data-ui-density` |
| messageDisplay | `data-message-display="cozy\|compact"` |
| contrast / saturation / reducedMotion | `data-contrast`, `--app-saturation`, `data-reduced-motion` |
| zoom | `--app-zoom` → `html { font-size: calc(16px * var(--app-zoom)) }` |
| chatFontScale / messageGroupSpacing | `--message-font-size`, `--message-group-gap` |
| roleColors | `data-role-colors="names\|dots\|off"` |
| streamerMode | `data-streamer-mode` → `.streamer-sensitive { filter: blur() }` |

ผลคือเปลี่ยนธีมหรือ density = เขียน attribute เดียว ไม่ re-render ทั้งต้นไม้

### 23.5 privacy — บังคับที่เซิร์ฟเวอร์

สองหมวดนี้ไม่ใช่แค่ค่าที่ client เคารพ แต่ REST API ปฏิเสธเองเลย:

| setting | จุดบังคับ |
|---|---|
| `allowDmsFrom: 'friends'` | `assertCanDirectMessage()` ใน `openDirectMessage` / `createGroupDM` |
| `allowServerMemberDms: false` | เดียวกัน |
| `friendRequests: 'none' \| 'friends_of_friends'` | `assertCanFriendRequest()` ใน `sendFriendRequest` |

`friends_of_friends` นับทั้ง "มีเพื่อนร่วมกัน" และ "อยู่เซิร์ฟเวอร์เดียวกัน"
ตามพฤติกรรม Discord ส่วน `dmScanning` เป็นเรื่องการแสดงผลล้วน (ปิดบังไฟล์แนบ
จากคนแปลกหน้าไว้ก่อน) จึงอยู่ฝั่ง client อย่างเดียว

มีเทสต์ครอบทั้งสองข้อใน `scripts/test-part3.mjs` — ยิง API ตรงโดยไม่ผ่าน UI
เพื่อพิสูจน์ว่า client ที่ถูกแก้แล้วก็ผ่านไม่ได้

### 23.6 keybinds

`useKeybinds()` ผูก listener เดียวที่ `window` แล้ว dispatch ตาม binding string
รูปแบบ `Ctrl+Shift+KeyM` (ใช้ `event.code` ไม่ใช่ `event.key` — layout ภาษาไทย
จึงไม่ทำให้ปุ่มลัดเพี้ยน) มีตัวตรวจ conflict ตอนตั้งค่า

ข้อจำกัดที่บอกผู้ใช้ตรง ๆ ในหน้า Settings: แท็บเบราว์เซอร์จองปุ่มลัดระดับ
ทั้งเครื่องไม่ได้ — push-to-talk ทำงานเฉพาะตอนหน้าต่างนี้ focus อยู่

---

## 24. กับดัก layout สองตัวที่ทำให้ overlay พัง

### 24.1 `filter` บน `body` ทำให้ `position: fixed` ตายทั้งแอป

อาการที่เจอ: หน้า login ถูกตัดครึ่งบนหายไปนอกจอ เลื่อนลงไปหาไม่ได้ เหลือแต่พื้นที่ว่างข้างล่าง

สาเหตุ: ตอนทำ Accessibility › Saturation เขียนไว้ว่า

```css
:root[data-saturation] body { filter: saturate(var(--app-saturation, 1)); }
```

ตามสเปก CSS Filter Effects — `filter`, `transform`, `perspective`,
`backdrop-filter`, `will-change` ค่าใดที่ไม่ใช่ `none` จะทำให้ element นั้น
กลายเป็น **containing block ของลูกที่เป็น `position: fixed`**
ยกเว้นอย่างเดียวคือ root element

`applyPreferences()` เซ็ต `data-saturation` ทุกครั้งที่บูต → `body` มี filter เสมอ
→ **overlay ที่เป็น `fixed` ทั้งแอปเลิก fixed กับ viewport** ไปยึดกับ `body` แทน
ซึ่ง `body` มีลูกเป็น fixed อย่างเดียวจึงสูงเกือบ 0 → `inset: 0` ได้กล่องสูง 0
→ `items-center` จัดกลางที่ y≈0 → ครึ่งบนของการ์ดลอยพ้นจอ แล้วโดน
`body { overflow: hidden }` ตัดทิ้ง เลื่อนตามไม่ได้

กระทบ: หน้า login, ทุก modal, toast, context menu และหน้า Settings เต็มจอที่เพิ่งทำ

**พิสูจน์ในเบราว์เซอร์จริง** (viewport 600px, body สูง 200px):

| ที่วาง filter | ความสูงของ overlay ที่ `inset:0` | ผล |
|---|---|---|
| ไม่มี filter | 600px | ยึด viewport ✅ |
| `body` | **200px** | ไปยึด body ❌ |
| `transform` บน `body` | **200px** | พังแบบเดียวกัน ❌ |
| `:root` | 600px | ยึด viewport ✅ |

แก้เป็น:

```css
:root[data-saturation]:not([data-saturation="100"]) {
  filter: saturate(var(--app-saturation, 1));
}
```

ย้ายไปไว้ที่ root (สเปกยกเว้นให้) และไม่ใส่ filter เลยเมื่อค่าเป็น 100 (ค่าเริ่มต้น)

**กันไม่ให้กลับมา**: `npm run a11y` มีตัวตรวจใหม่ที่ fail ทันทีถ้ามีใครใส่
property กลุ่มนี้ลงบน `body` หรือ `#root` พร้อมอธิบายว่าทำไมถึงห้าม

### 24.2 overlay ที่จัดกลางแล้วเลื่อนไม่ได้

`fixed inset-0 flex items-center` จัดกลางสวย จนกระทั่งการ์ดสูงกว่าจอ —
flexbox จะล้นออก **ทั้งสองด้าน** ครึ่งบนหลุดพ้น viewport และไม่มีทางเลื่อนกลับไปดู
เจอได้จริงบนโน้ตบุ๊กจอเตี้ย ฟอร์มยาว ๆ และแน่นอนที่ zoom 200% ซึ่งเป็นค่าที่
Appearance ของเราเปิดให้ตั้งเองได้

แก้ด้วย utility เดียวใน `index.css` แล้วเติม class ให้ overlay ทั้ง 10 จุด:

```css
.overlay-center { overflow-y: auto; overscroll-behavior: contain; }
.overlay-center > * { margin-block: auto; }
```

`margin-block: auto` จัดกลางเมื่อมีที่ว่าง และยุบเป็น 0 เมื่อไม่มี —
และ auto margin ชนะ `align-items` อยู่แล้ว จึงไม่ต้องแก้ `items-center` เดิมสักไฟล์

**พิสูจน์ในเบราว์เซอร์จริง** (viewport 600px):

| กรณี | ก่อนแก้ | หลังแก้ |
|---|---|---|
| การ์ดสูง 420px | เข้าถึงได้ครบ ✅ | เข้าถึงได้ครบ ✅ |
| การ์ดสูง 1400px | **บนและล่างเข้าไม่ถึง** ❌ | เลื่อนถึงครบ ✅ |

### 24.3 หน้า Settings เบี้ยวไปทางขวา และป้ายภาษาไทยโดนตัด

**เบี้ยว**: รอบแรกทำเป็นสองครึ่งจอ ครึ่งซ้ายชิดขวา ครึ่งขวาชิดซ้าย
วิธีนี้จัดกลางได้จริงก็ต่อเมื่อสองฝั่ง **กว้างเท่ากัน** แต่ของเราคือ 240 กับ 740

วัดบนจอ 1919px: rail อยู่ที่ 742–960, content อยู่ที่ 960–1700
→ ซ้ายว่าง **742px** ขวาว่าง **220px** → ทั้งบล็อกเบี้ยวขวา **261px**

แก้เป็นบล็อกเดียว `max-width: 1060px` จัดกลาง แล้ววาดสีพื้นด้วย gradient
ที่ตัดตรงขอบขวาของ rail พอดี — สี sidebar ยังไหลไปจนสุดขอบซ้ายเหมือน Discord
โดยไม่ต้องมี element เพิ่ม

```css
--settings-split: calc(max(0px, (100vw - 1060px) / 2) + 240px);
background: linear-gradient(to right,
  var(--color-d-surface) 0 var(--settings-split),
  var(--color-d-canvas)  var(--settings-split) 100%);
```

วัดหลังแก้: ซ้ายว่าง 430px ขวาว่าง 462px เบี้ยวจากจุดกึ่งกลาง **16px**

**ป้ายโดนตัด**: rail 218px + `truncate` ทำให้ป้ายไทยยาว ๆ ขาดหาย
เช่น "ความเป็นส่วนตัวและความปลอดภัย" เหลือ "ความเป็นส่วนตัวแล…"
อ่านไม่รู้เรื่อง 3 จาก 11 แท็บ

แก้เป็น rail 240px และ **ให้ขึ้นบรรทัดใหม่แทนการตัด** (`items-start` + ไอคอน
`mt-0.5` เพื่อให้ไอคอนตรงกับบรรทัดแรก) ทดสอบกับป้ายที่ยาวเกิน rail จริง ๆ:

| | ตัดคำ (เดิม) | ขึ้นบรรทัด (ใหม่) |
|---|---|---|
| ป้ายยาวเกิน rail | 1 บรรทัด **ข้อความขาด** ❌ | 3 บรรทัด อ่านครบ ✅ |

บทเรียน: ความกว้างของ sidebar ที่ Discord ใช้ (218px) ออกแบบมาสำหรับภาษาอังกฤษ
ภาษาไทยกินที่มากกว่าในจำนวนตัวอักษรเท่ากัน — เลย์เอาต์ที่ก๊อปมาตรง ๆ
ต้องเผื่อจุดนี้เสมอ

---

## 25. อัปโหลดรูปแล้วรูปไม่ขึ้น (เฉพาะตอน dev)

อาการ: กดอัปโหลดรูปโปรไฟล์แล้วไม่มีอะไรเปลี่ยน ไม่มี error ใน console
ไม่มี request สีแดงใน Network

สาเหตุอยู่ที่ `vite.config.js` ซึ่ง proxy ไปหา API แค่ `/api` กับ `/socket.io`
แต่ **ไบต์ของไฟล์ถูกเสิร์ฟที่ `/uploads`** (`app.use(PUBLIC_BASE, express.static(...))`)

```
POST /api/upload/avatar   → proxy ไป :3001 → สำเร็จ
   ตอบกลับ { url: "/uploads/avatars/3c/ec/….png" }
<img src="/uploads/…">    → ไม่เข้าเงื่อนไข proxy → ไปโดน Vite :5173
                          → Vite ตอบ SPA fallback
```

จุดที่ทำให้หายาก: Vite ตอบ **HTTP 200** พร้อม `content-type: text/html`
ไม่ใช่ 404 — เบราว์เซอร์จึงไม่ฟ้องอะไรเลย `<img>` แค่ได้ HTML มาแทนรูป
แล้วเรนเดอร์เป็นความว่างเปล่า

ยังหายากอีกชั้นเพราะ **grep หาในโค้ดไม่เจอ**: ไม่มีไฟล์ไหนเขียน `/uploads`
ไว้เลย path นี้มาจาก JSON ที่เซิร์ฟเวอร์ตอบตอน runtime

และ **production ไม่เป็น** เพราะ `SERVE_STATIC=1` ทำให้ทุกอย่างอยู่ origin เดียวกัน
— บั๊กจึงโผล่เฉพาะที่ที่คนทำงานอยู่จริงทุกวัน

แก้โดยเพิ่ม `/uploads` เข้า proxy พิสูจน์ด้วย proxy จำลองสองตัว:

| proxy | `<img>` ได้อะไรกลับมา | ผล |
|---|---|---|
| `['/api','/socket.io']` | 200 `text/html` (หน้า SPA) | รูปไม่ขึ้น ❌ |
| `['/api','/uploads','/socket.io']` | 200 `image/png` | รูปขึ้น ✅ |

กระทบทุกอย่างที่อัปโหลด ไม่ใช่แค่ avatar — แบนเนอร์, ไอคอนเซิร์ฟเวอร์,
emoji, สติกเกอร์ และไฟล์แนบในแชท

### 25.1 UX ของการเปลี่ยนรูป ปรับให้ตรง Discord

- รูปกลมกดได้ มี overlay กล้องตอน hover แทนปุ่ม "อัปโหลด" แยก
- **พรีวิวทันทีจากไฟล์ในเครื่อง** (`URL.createObjectURL`) ระหว่างที่ยังอัปโหลดไม่เสร็จ
  ถ้าไม่มีอันนี้ เน็ตช้า ๆ จะดูเหมือนกดแล้วไม่มีอะไรเกิดขึ้น แล้วคนก็กดซ้ำ
- อัปโหลดพลาด → **ถอนพรีวิวคืน** ไม่ปล่อยให้เห็นรูปที่จริง ๆ ไม่ได้ถูกเก็บ
- ตรวจชนิดและขนาดไฟล์ตั้งแต่ฝั่ง client บอกเป็นภาษาคนแทนที่จะให้เซิร์ฟเวอร์ตอบ 413
- **ล้างค่า `input.value` ทุกครั้ง** — ไม่งั้นเลือกไฟล์เดิมซ้ำจะไม่เกิด change event
  ลองใหม่หลังพลาดแล้วปุ่มจะเหมือนตาย
- `URL.revokeObjectURL` ทุกครั้งที่เปลี่ยนหรือออกจากหน้า

---

## 26. Polls (migration v9)

### 26.1 ทำไมโพลถึง *เป็น* ข้อความ

`polls.message_id` เป็น primary key ไม่ใช่ id แยก — โพลที่ไม่มีข้อความเจ้าของไม่มีอยู่จริง
การผูกเป็น 1:1 ตั้งแต่โครงสร้างจึงตัดปัญหา orphan ทิ้งทั้งคลาส
และได้ permission ของห้อง, กติกาแก้/ลบ, ตำแหน่งใน history มาฟรีทั้งหมด

ตัวเลือกแยกเป็นตารางลูก ไม่ใช่ JSON เพราะ **โหวตต้องอ้างถึงตัวเลือก** และ
foreign key คือสิ่งเดียวที่กันการโหวตให้ตัวเลือกที่ถูกลบไปแล้วได้จริง

### 26.2 นับคะแนนทุกครั้ง ไม่เก็บ counter

คอลัมน์นับคะแนนต้องถูกต้องข้ามการถอนโหวต ลบตัวเลือก และ cascade delete ของ user
— นับ row เอาไม่มีทางเพี้ยน ส่วนเปอร์เซ็นต์คิดจาก **จำนวนคน** ไม่ใช่จำนวนโหวต
โพลแบบเลือกหลายข้อจึงรวมเกิน 100% ได้ตามจริง (Discord ก็แสดงแบบนี้)

### 26.3 การโหวตส่ง "เซ็ตทั้งหมด" ไม่ใช่ delta

`PUT /api/polls/:id/vote` รับ `answer_ids` เป็นรายการที่ต้องการทั้งชุด
ทำให้ **idempotent**: ยิงซ้ำได้ผลเดิม ไม่ toggle กลับ ซึ่งสำคัญมากตอนเน็ตไม่นิ่ง
และไคลเอนต์ไม่รู้ว่าครั้งแรกถึงเซิร์ฟเวอร์หรือยัง ส่ง array ว่าง = ถอนโหวต

### 26.4 หมดอายุตอนอ่าน ไม่ใช้ timer

ไม่มี scheduler ให้ดูแล ไม่มี drift เมื่อ process รีสตาร์ต —
เซิร์ฟเวอร์ที่ปิดไปทั้งสุดสัปดาห์กลับมาแล้วยังถูกต้อง เพราะการอ่านครั้งแรก
หลังเลยกำหนดจะปิดโพลให้เอง แล้วครั้งต่อ ๆ ไปเห็นค่าเดิมคงที่

### 26.5 realtime

โหวตหนึ่งครั้ง broadcast `poll_updated` (แค่โพล ไม่ใช่ข้อความทั้งก้อน)
และ **ตัด `my_votes` ออกจาก broadcast** เพราะเป็นข้อมูลเฉพาะคน —
ไคลเอนต์เก็บของตัวเองไว้ ไม่งั้นทุกคนจะเห็นว่าตัวเองโหวตตามคนที่โหวตล่าสุด

ฝั่ง UI โหวตแบบ optimistic (ติ๊กและแถบขยับทันที) แล้ว reconcile กับคำตอบเซิร์ฟเวอร์
ถ้าพลาดก็ย้อนคืนพร้อม toast

### 26.6 migration รื้อ CHECK constraint

SQLite ไม่มี ALTER สำหรับ CHECK — การเพิ่ม `'poll'` เข้า `messages.type`
ต้องสร้างตารางใหม่ ก๊อปข้อมูล แล้ว rename ทำใน transaction ของ migration เอง
พร้อมปิด foreign key ชั่วคราว จึงไม่มีใครเห็นสถานะครึ่ง ๆ กลาง ๆ
DB ที่สร้างใหม่ข้ามขั้นนี้ทั้งหมด (ตรวจจาก DDL ก่อน)

---

## 27. Soundboard — ทำไมไม่ผสมเข้าไมค์

เสียงเอฟเฟกต์ **ไม่ได้** ถูกผสมเข้า track ไมค์ของคนกด แต่ gateway broadcast ว่า
"เล่นเสียงนี้" แล้วทุกคนในห้องเล่นเองที่เครื่องตัวเอง

เหตุผล:
1. track เสียงพูดถูกบีบอัดหนักและมี noise gate — ซึ่งผิดสำหรับเสียงเอฟเฟกต์โดยสิ้นเชิง
2. คนกดไม่ต้องเสีย upstream เพิ่ม ซึ่งเป็นทรัพยากรที่ขาดแคลนที่สุดใน full mesh

ผลข้างเคียงที่ยอมรับ: คนที่ mute คนกดไว้ก็ยังได้ยินเสียงเอฟเฟกต์
Discord ก็ทำแบบเดียวกัน ส่วนคนที่ **deafen** ไม่ได้ยิน เพราะ deafen คือปิดทั้งห้อง
และเสียงเอฟเฟกต์เป็นส่วนหนึ่งของห้อง

เล่นผ่าน Web Audio ไม่ใช่ `<audio>` เพราะ (ก) GainNode ดันเกิน 1.0 ได้
ตามสไลเดอร์ซาวด์บอร์ด (ข) เล่นซ้อนกันได้ — `<audio>` ตัวเดียวอยู่ได้ตำแหน่งเดียว
กดซ้ำจะตัดเสียงแรกทิ้ง

cooldown 1.5 วินาที **ต่อคน** ไม่ใช่ต่อห้อง — คนหนึ่งสแปมไม่ควรทำให้คนอื่นกดไม่ได้
และเซิร์ฟเวอร์ตรวจว่าคนกดอยู่ในห้องเสียงนั้นจริง ไม่งั้นใครรู้ channel id ก็ยิงเสียงใส่ห้องที่ตัวเองไม่ได้อยู่ได้

---

## 28. Voice notes

`attachments.waveform` เก็บเป็น string ของตัวเลข 0–100 คั่นด้วยจุลภาค
**คลื่นเสียงเป็นฟิลด์เดียวที่เชื่อ client** เพราะเบราว์เซอร์ decode เสียงไปแล้วตอนอัด
การมาถอดซ้ำที่เซิร์ฟเวอร์ = decode ทุกไฟล์ใหม่เพื่อกราฟแท่งกว้าง 120px

แต่ "เชื่อ" ไม่ได้แปลว่า "รับดิบ" — `normaliseWaveform()` **จำกัดที่ 64 จุด**
และ **clamp 0–100** ทุกค่า ไม่งั้น waveform 10,000 จุดจะไปถ่วง response
ของ history ทุกครั้งที่โหลดห้อง ส่วน **duration เอาจาก probe ของเซิร์ฟเวอร์เอง**
เพราะอันนั้นมีความหมายจริงและ client โกหกได้

RMS ไม่ใช่ peak: เสียงคลิกเดียวจะทำให้กราฟแบบ peak เป็นหนามหมดทั้งอัน
ส่วน RMS ตามความดังที่หูรับรู้ ซึ่งคือสิ่งที่ภาพนี้ควรสื่อ

เลือก container ด้วย `MediaRecorder.isTypeSupported()` ไม่ใช่เดา —
Chrome/Firefox ได้ webm/opus แต่ **Safari ปฏิเสธ webm** และให้ mp4/aac แทน
ถามเบราว์เซอร์คือความต่างระหว่างใช้ได้กับ Safari กับพังเงียบ ๆ

`waveform` ที่มีค่า = สิ่งที่บอกให้ client เรนเดอร์ player แทน file chip

---

## 29. Slash commands

แบ่งเป็นสองชนิด และการแยกนี้คือสิ่งที่ทำให้ทั้งระบบเรียบง่าย:

| ชนิด | ทำอะไร | ตัวอย่าง |
|---|---|---|
| **transform** | เขียนข้อความใหม่แล้วส่งเป็นข้อความธรรมดา | `/me` `/shrug` `/spoiler` `/tts` |
| **action** | ทำอย่างอื่นแทนการส่งข้อความ | `/poll` `/nick` `/search` `/thread` |

**transform ทำสิ่งที่ผู้ใช้พิมพ์เองได้อยู่แล้ว** — เป็นทางลัด ไม่ใช่สิทธิพิเศษ
จึงไม่มีอะไรต้องขออนุญาต และไม่มีพฤติกรรมใหม่ที่เซิร์ฟเวอร์ต้องเชื่อ
ส่วน action ทุกตัวชี้ไปที่เส้นทางที่แอปมีอยู่แล้ว ไม่ใช่ implementation ที่สอง
— จึงไม่มีทางเพี้ยนจากปุ่มที่ทำสิ่งเดียวกัน

`/notacommand` ได้ **error ไม่ใช่ส่งเป็นข้อความ** — Discord ก็ปฏิเสธ
และการเผลอโพสต์คำสั่งที่พิมพ์ผิดลงห้องแย่กว่าการเห็น error เล็ก ๆ

เดิมมีตารางคำสั่งซ้ำสองที่ (ใน `ComposerAutocomplete` กับที่ควรจะเป็น) —
รวมเหลือแหล่งเดียวที่ `utils/slashCommands.js` เพราะรายการที่ autocomplete รู้จัก
แต่ตัวรันไม่รู้จัก จะเติมคำให้แล้วส่งไม่ได้

การกด autocomplete **เติมชื่อคำสั่งเฉย ๆ** ไม่ได้รันทันที จึงยังพิมพ์ argument ต่อได้


## 30. Scheduled events

`services/events.js` owns the `scheduled_events` and `event_interest` tables.
An event is created against a voice/stage channel *or* a free-text location,
never neither; a past start time is refused. Lifecycle is settled on read
(`settle()`), the same pattern as poll expiry: a channel event becomes
`active` once its start passes and `completed` at `ends_at` (or start + 1 h
when no end was given). Cancelling an active event marks it `completed`, not
`cancelled`, because it did happen. Interest is an idempotent toggle
(`PUT /api/events/:id/interest {interested}`); the creator is interested by
default. `server.js` runs a 60-second reminder loop that emits
`event_reminder` to every interested user 15 minutes ahead, de-duplicated in
memory — a restart at most repeats one reminder.

## 31. Profile privacy, notes and friend-request notes

`users.profile_visibility` (`everyone | mutual | friends`) is read by the
server when *other people* look at you, so it lives on the user row rather than
in client preferences. `getUser(userId, viewerId)` strips bio/banner/pronouns
and sets `profile_hidden` when `canSeeProfile` fails. `user_notes` are the
viewer's private text about another user (256 chars, empty deletes, never
about yourself). `friends.note` carries the optional message on a friend
request (200 chars) and is surfaced as `request_note` on pending rows.

## 32. Vanity URL, verification level, AFK

A vanity slug (`^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$`, 2–32 chars) is checked
for uniqueness across servers *and* against live invite codes, so a slug can
never shadow someone's invite. `getInvitePreview` and `acceptInvite` resolve a
vanity first, then fall through to codes, so `/join/<slug>` works everywhere a
code does. A rejected write never touches the stored slug (tested).

`verification_level` 0–4 is enforced in `joinServer` via
`assertVerificationLevel`: 1 needs a verified e-mail, 2 an account ≥ 5 min
old, 3 ≥ 10 min, 4 MFA enabled. Errors carry codes `VERIFICATION_EMAIL`,
`VERIFICATION_AGE`, `VERIFICATION_MFA` so the client can explain the refusal.

`realtime.sweepAfk(io)` runs every 30 s. A user in a voice channel who has not
spoken for `afk_timeout` seconds (presets 60/300/900/1800/3600) is moved to
`afk_channel_id`; their socket leaves/joins the voice rooms and receives
`voice_moved {from,to,reason:'afk'}` so the mesh re-negotiates. A user this
process has never observed (a voice_state that survived a restart) has their
clock *started*, not expired, on the first sweep.

## 33. Forum channels

Discord's model, copied exactly: a forum post *is* a thread (`channels.type =
'thread'`, `parent_id` = the forum) and the post body is the thread's first
message. Replies, reactions, read state, archiving and membership therefore
come for free from §§ threads/messages. `services/forum.js` adds only the forum
vocabulary:

* **Tags** — `forum_tags` (≤ 20 per forum, name unique case-insensitively,
  optional emoji, `moderated` = staff-only) and `forum_post_tags` (≤ 5 per
  post). Applying a moderated tag needs `MANAGE_THREADS`; editing tags on a
  post is author-or-staff. Tag CRUD is `MANAGE_CHANNELS`.
* **Create post** — title + body/attachments + tags in one transaction, so a
  thread without a starter message cannot exist. Needs
  `CREATE_PUBLIC_THREADS` and `SEND_MESSAGES`. Plain `POST /api/messages`
  into a forum is refused with `FORUM_NEEDS_POST`.
* **List** — pinned first, then `latest_activity` (max message time) or
  `creation_date`; filter by tag ids (AND), search title *and* replies,
  `before` cursor on the sort key, `has_more`. Each card carries author,
  preview (first 300 chars), reply count, a thumbnail resolved through the
  storage layer (private files stay private) and starter-message reactions.
* **Pin** — `channels.pinned`, staff only. **Forum defaults** —
  `default_sort_order`, `require_tag`, `default_reaction_emoji` on the forum
  row, `PATCH /api/channels/:id/forum`.

Realtime: `thread_created` (existing) + `forum_post_created` on new posts,
`forum_post_updated` on tag/pin changes, `forum_tags_updated` to the forum's
channel room. The client (`ForumView.jsx`) swaps in for `ChatArea` when the
active channel is a forum; opening a post sets the active channel to the
thread, so the normal thread view renders it, now with a parent crumb.

Migration v11 is column-additive and was verified against a v10 database
(columns dropped, marker removed, re-run).

Tests: 9 in `test-part3.mjs` (`forum channels`). The integration harness
raises the write rate limit via `RATE_LIMIT_WRITE_PER_MIN`; production keeps
60/min.

### 33a. Media channels

A "media" channel is a forum whose `default_layout` is `gallery`
(`POST /api/channels {type:'media'}` stores `type='forum'`). Every forum code
path applies; the client renders a thumbnail grid instead of the list. Layout
is per-forum (staff) and per-viewer (toolbar toggle, not persisted).

## 34. Membership screening, welcome screen, onboarding

`services/onboarding.js`. Three features that share one moment — joining:

* **Screening** — `servers.screening_enabled` + `screening_rules` (JSON, ≤10).
  `joinServer` sets `server_members.pending = 1` when screening is on;
  `resolvePermissions` treats pending exactly like a timeout (view + read
  history only), so *every* write path is gated by the one permission gate.
  Screening cannot be enabled with zero rules (`RULES_REQUIRED`).
* **Welcome screen** — `welcome_enabled`, `welcome_description` (≤140) and
  `welcome_channels` (≤5, each with a description and optional emoji).
* **Onboarding prompts** — `onboarding_prompts` / `onboarding_options`
  (≤7 × ≤12). An option grants channel picks and roles. Written as a whole
  set (`PUT …/prompts`); referenced channels/roles must belong to the guild.
* **Complete** — `PUT /api/servers/:id/onboarding/complete {accept_rules,
  answers}` validates rules acceptance, required prompts and single-select,
  records `member_onboarding`, re-derives onboarding-granted roles (drops
  deselected ones, never touches staff-granted roles), lifts `pending` and
  returns the server detail plus `picked_channel_ids` / `granted_role_ids`.
  Idempotent: resubmitting replaces the answers.

`getServerDetail` returns `viewer_pending` and `has_onboarding`; the client
opens `OnboardingModal` when pending (non-dismissable until rules are
accepted) or once per server otherwise (remembered in localStorage). Staff
edit everything in Server Settings → Onboarding (`settings/OnboardingTab.jsx`).
Realtime: `onboarding_updated` (config) and `member_updated` (completion).

Migration v12 is column-additive. Tests: 4 in `test-part3.mjs` (`onboarding`),
covering the pending gate end-to-end with a freshly registered account.

## 35. Channel following

`services/following.js`. Following an announcement channel from a text
channel (possibly in another server) creates a `follower`-type webhook in the
target whose name/avatar are the source server's, plus a `channel_follows`
row. `POST /api/messages/:id/crosspost` relays the message through every
follower webhook: each copy is a real message row (history, search, reactions
work) with `webhook_id` set, so it renders as "*Source* #announcements".
`message_crossposts` maps original → copies: publish is idempotent, and
deleting the original retracts every copy. Publishing your own message needs
`SEND_MESSAGES`; someone else's needs `MANAGE_MESSAGES`; following needs
`MANAGE_WEBHOOKS` in the target. Relay webhooks have an unusable token — only
`publish()` writes through them. `messages.flags & 1` = CROSSPOSTED
(`crossposted` on the wire). Side fix: webhook-authored messages now display
the webhook's name/avatar persistently (the SELECT joins `webhooks`).

## 36. Stage channels

Realtime only — no new tables. `voice_states.suppress` marks the audience;
`request_to_speak_at` a raised hand. Joining a stage sets `suppress = 1`
unless the joiner holds `MUTE_MEMBERS` in the channel (stage moderator).
`stage_request_speak {requesting}` raises/lowers a hand; `stage_set_speaker
{userId, speaker}` needs `MUTE_MEMBERS` except for a speaker stepping down.
A suppressed member's `voice_state_change {isMuted:false}` is refused with
`voice_error SUPPRESSED`; the client also disables the mic track
(`useVoiceMedia({isMuted: isMuted || suppressed})`). Roster carries
`isSuppressed` / `requestedToSpeakAt`; `VoiceRoom` shows speakers as tiles and
the audience as a strip with hands first. Tested over a real socket.io
connection (`test-part2.mjs` → `stage channels`).

## 37. Cross-server emoji

`GET /api/users/@me/emojis` groups every custom emoji from the viewer's
servers; the picker shows one section per server. `GET /api/emojis/:id/image`
redirects to the image so `<:name:id>` renders anywhere (relays, forwards,
DMs). Enforcement lives in `createMessage`
(`assertExternalEmojiAllowed`) and `toggleReaction`: unknown ids are refused
(`EMOJI_UNKNOWN`); an emoji from another server needs `USE_EXTERNAL_EMOJIS`
in the channel *and* membership of the emoji's server. Emoji ids are numeric
snowflakes — the `<:name:id>` pattern only matches digits.

## 38. Server folders

A `layout` preference category (`serverFolders`, `serverOrder`) synced like
every other preference. `ServerRail` builds rows from it: drag a server onto
another to fold them, onto a folder to join, into a gap to reorder (which also
removes it from a folder). Folders collapse; a folder containing the active
server stays open. Server-side validation bounds ids/colours and drops empty
folders.

## 39. Server templates

`services/templates.js`. One template per server (`server_templates`,
migration v14) holding a JSON snapshot: roles (`@everyone` kept as key
`everyone`), categories and channels with fields, role overwrites, forum tags,
and a few server settings. Members, messages, emoji files and invites are
never included. `POST /api/templates/:code/servers` recreates everything with
fresh ids, re-mapping overwrites onto the new roles and re-pointing
system/rules/AFK channels; the caller becomes owner. `/template/:code` deep
links open the create-server flow with the code filled in.

Also added: `scripts/parse-check.mjs` (real JSX parse of every client file via
@babel/parser) in `npm run verify`.

## 40. Why the app went blank once, and what now prevents it

A blank page at `localhost:5173` was traced to three separate gaps. All three
are now closed by a check that fails loudly.

**1. `ReferenceError: Radio is not defined`.** `ChannelSidebar.jsx` used
`Radio` in its channel-icon table, but the edit that was supposed to add it to
the `lucide-react` import did not land. The file parsed, Vite served it, and
React threw at render — a white screen with the reason only in the console.
`jsx-check` looks at `<JSX>` tags, so a bare identifier slipped past it.
→ `scripts/parse-check.mjs` now does scope analysis with `@babel/traverse`
over **all 117 client *and* server files** and fails on any identifier that is
referenced but never imported, declared, or a known global. Verified by
re-introducing the exact bug: the check catches it and exits non-zero.

**2. Dialogs pinned to the top-left.** The house convention is that the
`fixed inset-0` backdrop carries `flex items-center justify-center
overlay-center`, and the card inside is a plain block. The follow / forum /
onboarding dialogs put `overlay-center` on the *card* and omitted the
centring, so they rendered in the corner. → `a11y-audit.mjs` gained
`auditOverlayCentring()`: a scrolling flex backdrop with no `items-*`
alignment is an error, and so is `overlay-center` on anything that is not the
backdrop. Deliberate exceptions (QuickSwitcher's `items-start`, the
full-bleed Server Settings surface) are not flagged.

**3. A backend running yesterday's code.** Vite hot-reloads the client, but
`node server.js` does not restart itself: every route added in Batch 2–4
returned 404 while the UI looked fine. → `npm run server` is now
`node --watch server.js` (`server:once` keeps the old behaviour), `/api/health`
reports `code_schema_version` (what the running process was built against)
next to `schema_version` (what the database is at), and the client compares it
to its own `EXPECTED_SCHEMA_VERSION` on boot and shows an error toast telling
you to restart. A test keeps that constant in step with `db.js`.
