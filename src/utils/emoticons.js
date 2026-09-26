// Text emoticons → emoji, as Discord's "Automatically convert emoticons in
// your messages to emoji" does. Only whole tokens convert (so "http://x" and
// "a:b" survive), and never inside `inline` or ```fenced``` code.

const EMOTICONS = {
  ':)': '🙂', ':-)': '🙂', '(:': '🙂',
  ':(': '🙁', ':-(': '🙁', '):': '🙁',
  ':D': '😀', ':-D': '😀', 'xD': '😆', 'XD': '😆',
  ';)': '😉', ';-)': '😉',
  ':P': '😛', ':-P': '😛', ':p': '😛', ':-p': '😛',
  ':O': '😮', ':-O': '😮', ':o': '😮', ':-o': '😮',
  ':|': '😐', ':-|': '😐',
  ":'(": '😢', ':/': '😕', ':-/': '😕',
  '<3': '❤️', '</3': '💔',
  '8)': '😎', 'B)': '😎',
  '>:(': '😠', ':*': '😘'
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// Longest first, so ">:(" wins over ":(".
const TOKEN = new RegExp(
  `(^|\\s)(${Object.keys(EMOTICONS).sort((a, b) => b.length - a.length).map(escape).join('|')})(?=$|\\s)`,
  'g'
);

function convertPlain(text) {
  return text.replace(TOKEN, (match, lead, emoticon) => lead + EMOTICONS[emoticon]);
}

export function convertEmoticons(text) {
  if (!text) return text;
  // Split out code spans and blocks, convert only the prose between them.
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) => (index % 2 === 1 ? part : convertPlain(part)))
    .join('');
}
