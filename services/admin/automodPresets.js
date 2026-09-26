// ============================================================================
//  AutoMod keyword presets — Discord's "Commonly flagged words" lists, plus
//  the two spam lists small communities ask for first.
//
//  The word lists stay on the server: the settings screen only needs each
//  preset's id, and shipping a slur list to every browser helps nobody. A rule
//  stores the preset ids in trigger_metadata.presets; the words are expanded
//  when the rule is evaluated, so improving a list improves every rule using it.
//
//  Matching is substring-based after normalisation (see textNormalize.js), so
//  entries that are common inside innocent words are left out on purpose, and
//  `allow` holds known innocent words that contain an entry.
// ============================================================================

export const AUTOMOD_PRESETS = Object.freeze({
  profanity_en: {
    words: [
      'fuck', 'motherfucker', 'shit', 'bullshit', 'bitch', 'asshole', 'cunt', 'bastard',
      'wanker', 'twat', 'bollocks', 'dickhead', 'slut', 'whore', 'cocksucker', 'pussy'
    ],
    allow: ['scunthorpe', 'shitake', 'shiitake', 'cockpit', 'pussycat', 'pussy willow']
  },
  profanity_th: {
    words: [
      'ควย', 'เหี้ย', 'สัส', 'ไอ้สัตว์', 'อีสัตว์', 'เย็ดแม่', 'ส้นตีน', 'ชิบหาย', 'ระยำ',
      'จัญไร', 'อีดอก', 'ดอกทอง', 'กะหรี่', 'อีเวร', 'ไอ้เวร', 'หน้าหี', 'แม่ง'
    ],
    allow: []
  },
  slurs: {
    words: [
      'nigger', 'nigga', 'faggot', 'retard', 'tranny', 'kike', 'chink', 'wetback', 'gook',
      'ไอ้ตุ๊ด', 'อีกะเทย', 'ไอ้ลาว', 'ไอ้เขมร', 'ไอ้พม่า', 'ไอ้ปัญญาอ่อน'
    ],
    allow: []
  },
  sexual: {
    words: [
      'porn', 'nudes', 'send nudes', 'onlyfans', 'hentai', 'xxx', 'sex cam', 'camgirl',
      'เย็ด', 'โป๊', 'คลิปหลุด', 'ขายตัว', 'ขายรูปโป๊', 'หนังโป๊', 'เงี่ยน'
    ],
    allow: []
  },
  spam_links: {
    words: [
      'free nitro', 'free-nitro', 'discord-nitro', 'discordgift', 'dlscord', 'disc0rd',
      'steamcommunity-', 'steamcommuntiy', 'grabify', 'iplogger', 'bit.ly/', 'tinyurl.com/',
      'claim your gift', 'airdrop', 'เครดิตฟรี', 'แจกเครดิต', 'สล็อต', 'บาคาร่า', 'เว็บตรง'
    ],
    allow: []
  },
  invite_links: {
    words: ['discord.gg/', 'discord.com/invite', 'discordapp.com/invite', 'dsc.gg/', 'discord.me/', 'line.me/ti/g', 'chat.whatsapp.com/', 't.me/joinchat'],
    allow: []
  }
});

export const PRESET_IDS = Object.freeze(Object.keys(AUTOMOD_PRESETS));

/** Keywords and allow-list for a rule's trigger_metadata, presets expanded. */
export function expandKeywords(meta = {}) {
  const keywords = [];
  const allow = [];
  for (const id of Array.isArray(meta.presets) ? meta.presets : []) {
    const preset = AUTOMOD_PRESETS[id];
    if (!preset) continue;
    keywords.push(...preset.words);
    allow.push(...preset.allow);
  }
  for (const k of Array.isArray(meta.keywords) ? meta.keywords : []) {
    const clean = String(k ?? '').trim();
    if (clean) keywords.push(clean);
  }
  for (const a of Array.isArray(meta.allow_list) ? meta.allow_list : []) {
    const clean = String(a ?? '').trim();
    if (clean) allow.push(clean);
  }
  return { keywords: [...new Set(keywords)], allow: [...new Set(allow)] };
}
