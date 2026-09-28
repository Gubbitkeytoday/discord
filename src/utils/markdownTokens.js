// ============================================================================
//  Discord-flavoured markdown: the inline token grammar.
//
//  Shared by the React renderer (markdownParser.jsx) and the plain-text
//  summariser (plainText.js), so a reply preview, the inbox and search agree
//  with the message itself on what is markup. No React, no DOM: importable
//  from Node tests.
// ============================================================================

// Order matters: longer delimiters must be tried before their prefixes, so
// ``` before `, ** before *, and __ before _.
//
// Kept as a *source string*, not a shared RegExp: renderInline recurses into
// itself for nested markup like **bold *italic***, and a module-level /g regex
// carries `lastIndex` between those nested calls — which corrupts the outer
// scan and can spin forever.
export const INLINE_SOURCE = [
  // A backslash escapes one markdown character, as in Discord: `\*not italic\*`,
  // and what /shrug sends (¯\\\_(ツ)\_/¯) so its arms are not italics.
  '\\\\[\\\\*_~`|<>#:\\[\\]()-]',
  '\\|\\|[\\s\\S]+?\\|\\|',                 // spoiler
  '`[^`\\n]+`',                             // inline code
  // Lazy [\s\S]+? rather than [^*]+ so a nested span survives:
  // **bold *italic* more** must match the whole bold run, then recurse.
  '\\*\\*\\*[\\s\\S]+?\\*\\*\\*',           // bold italic
  '\\*\\*[\\s\\S]+?\\*\\*',                 // bold
  '__[\\s\\S]+?__',                         // underline
  '~~[\\s\\S]+?~~',                         // strikethrough
  // Emphasis needs a non-space next to each delimiter, otherwise arithmetic
  // like "2 * 3 * 4" turns italic.
  '\\*(?!\\*)(?!\\s)[^\\n]+?(?<!\\s)\\*(?!\\*)',
  // Underscore emphasis only at word boundaries, so snake_case_names survive.
  '(?<![\\p{L}\\p{M}\\p{N}_])_(?!_)(?!\\s)[^\\n]+?(?<!\\s)_(?!_)(?![\\p{L}\\p{M}\\p{N}_])',
  '<a?:\\w+:\\d+>',                         // custom emoji
  '<@!?[\\w-]+>',                           // user mention
  '<@&[\\w-]+>',                            // role mention
  '<#[\\w-]+>',                             // channel mention
  '<t:\\d+(?::[tTdDfFR])?>',                // timestamp
  '\\[[^\\]\\n]+\\]\\((?:https?:\\/\\/|\\/)[^)\\s]+\\)', // markdown link
  'https?:\\/\\/[^\\s<]+',                  // bare URL
  '@(?:everyone|here)\\b'                   // mass mention
].join('|');

export const CODE_BLOCK_SOURCE = '```(?:([\\w+-]+)\\n)?([\\s\\S]*?)```';
