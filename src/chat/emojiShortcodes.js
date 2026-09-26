// ============================================================================
//  Unicode emoji shortcodes (Discord / GitHub names).
//
//  Used for: `:fire:` → 🔥 on send, `:` autocomplete in the composer, and the
//  picker's search and accessible names (":thumbsup:" rather than a raw glyph
//  that some screen readers read as "image"). Not the full CLDR table — the
//  common set people actually type; anything missing stays literal text.
// ============================================================================

const RAW = `
grinning 😀|smiley 😃|smile 😄|grin 😁|laughing 😆|satisfied 😆|sweat_smile 😅|rofl 🤣|joy 😂|slight_smile 🙂|slightly_smiling_face 🙂|upside_down 🙃|wink 😉|blush 😊|innocent 😇|smiling_face_with_hearts 🥰|heart_eyes 😍|star_struck 🤩|kissing_heart 😘|kissing 😗|yum 😋|stuck_out_tongue 😛|stuck_out_tongue_winking_eye 😜|zany_face 🤪|stuck_out_tongue_closed_eyes 😝|money_mouth 🤑|hugging 🤗|hug 🤗|hand_over_mouth 🤭|shushing_face 🤫|thinking 🤔|zipper_mouth 🤐|raised_eyebrow 🤨|neutral_face 😐|expressionless 😑|no_mouth 😶|smirk 😏|unamused 😒|rolling_eyes 🙄|grimacing 😬|lying_face 🤥|relieved 😌|pensive 😔|sleepy 😪|drooling_face 🤤|sleeping 😴|mask 😷|thermometer_face 🤒|head_bandage 🤕|nauseated_face 🤢|vomiting 🤮|sneezing_face 🤧|hot_face 🥵|cold_face 🥶|woozy_face 🥴|dizzy_face 😵|exploding_head 🤯|cowboy 🤠|partying_face 🥳|disguised_face 🥸|sunglasses 😎|nerd 🤓|nerd_face 🤓|monocle_face 🧐|confused 😕|worried 😟|slight_frown 🙁|open_mouth 😮|hushed 😯|astonished 😲|flushed 😳|pleading_face 🥺|frowning 😦|anguished 😧|fearful 😨|cold_sweat 😰|disappointed_relieved 😥|cry 😢|sob 😭|scream 😱|confounded 😖|persevere 😣|disappointed 😞|sweat 😓|weary 😩|tired_face 😫|yawning_face 🥱|triumph 😤|rage 😡|pout 😡|angry 😠|cursing_face 🤬|smiling_imp 😈|imp 👿|skull 💀|skull_crossbones ☠️|poop 💩|hankey 💩|clown 🤡|ogre 👹|goblin 👺|ghost 👻|alien 👽|robot 🤖|smiley_cat 😺|heart_eyes_cat 😻|see_no_evil 🙈|hear_no_evil 🙉|speak_no_evil 🙊|
wave 👋|raised_back_of_hand 🤚|raised_hand ✋|hand ✋|vulcan 🖖|ok_hand 👌|pinched_fingers 🤌|pinching_hand 🤏|v ✌️|crossed_fingers 🤞|love_you_gesture 🤟|metal 🤘|call_me 🤙|point_left 👈|point_right 👉|point_up_2 👆|point_down 👇|point_up ☝️|thumbsup 👍|+1 👍|thumbs_up 👍|thumbsdown 👎|-1 👎|thumbs_down 👎|fist ✊|punch 👊|left_facing_fist 🤛|right_facing_fist 🤜|clap 👏|raised_hands 🙌|open_hands 👐|palms_up_together 🤲|handshake 🤝|pray 🙏|writing_hand ✍️|nail_care 💅|selfie 🤳|muscle 💪|brain 🧠|eyes 👀|eye 👁️|tongue 👅|lips 👄|kiss 💋|baby 👶|boy 👦|girl 👧|man 👨|woman 👩|older_man 👴|older_woman 👵|
dog 🐶|cat 🐱|mouse 🐭|hamster 🐹|rabbit 🐰|fox 🦊|bear 🐻|panda 🐼|koala 🐨|tiger 🐯|lion 🦁|cow 🐮|pig 🐷|frog 🐸|monkey_face 🐵|chicken 🐔|penguin 🐧|bird 🐦|baby_chick 🐤|duck 🦆|eagle 🦅|owl 🦉|bat 🦇|wolf 🐺|boar 🐗|horse 🐴|unicorn 🦄|bee 🐝|bug 🐛|butterfly 🦋|snail 🐌|lady_beetle 🐞|ant 🐜|spider 🕷️|scorpion 🦂|turtle 🐢|snake 🐍|lizard 🦎|octopus 🐙|squid 🦑|shrimp 🦐|crab 🦀|blowfish 🐡|tropical_fish 🐠|fish 🐟|dolphin 🐬|whale 🐳|shark 🦈|crocodile 🐊|elephant 🐘|cactus 🌵|christmas_tree 🎄|evergreen_tree 🌲|deciduous_tree 🌳|palm_tree 🌴|seedling 🌱|herb 🌿|shamrock ☘️|four_leaf_clover 🍀|leaves 🍃|fallen_leaf 🍂|maple_leaf 🍁|tulip 🌷|rose 🌹|wilted_rose 🥀|hibiscus 🌺|cherry_blossom 🌸|blossom 🌼|sunflower 🌻|sun_with_face 🌞|full_moon_with_face 🌝|crescent_moon 🌙|star ⭐|star2 🌟|sparkles ✨|zap ⚡|fire 🔥|rainbow 🌈|sunny ☀️|partly_sunny ⛅|cloud ☁️|cloud_rain 🌧️|thunder_cloud_rain ⛈️|snowflake ❄️|snowman ⛄|droplet 💧|ocean 🌊|
apple 🍎|green_apple 🍏|pear 🍐|tangerine 🍊|lemon 🍋|banana 🍌|watermelon 🍉|grapes 🍇|strawberry 🍓|blueberries 🫐|cherries 🍒|peach 🍑|mango 🥭|pineapple 🍍|coconut 🥥|kiwi 🥝|tomato 🍅|eggplant 🍆|avocado 🥑|broccoli 🥦|cucumber 🥒|hot_pepper 🌶️|corn 🌽|carrot 🥕|garlic 🧄|onion 🧅|potato 🥔|croissant 🥐|bread 🍞|baguette_bread 🥖|pretzel 🥨|cheese 🧀|egg 🥚|cooking 🍳|waffle 🧇|pancakes 🥞|bacon 🥓|cut_of_meat 🥩|poultry_leg 🍗|meat_on_bone 🍖|hotdog 🌭|hamburger 🍔|burger 🍔|fries 🍟|pizza 🍕|sandwich 🥪|taco 🌮|burrito 🌯|salad 🥗|spaghetti 🍝|ramen 🍜|stew 🍲|curry 🍛|sushi 🍣|bento 🍱|dumpling 🥟|fried_shrimp 🍤|rice_ball 🍙|rice 🍚|shaved_ice 🍧|ice_cream 🍨|icecream 🍦|pie 🥧|cupcake 🧁|cake 🍰|birthday 🎂|custard 🍮|lollipop 🍭|candy 🍬|chocolate_bar 🍫|popcorn 🍿|doughnut 🍩|donut 🍩|cookie 🍪|coffee ☕|tea 🍵|bubble_tea 🧋|cup_with_straw 🥤|beer 🍺|beers 🍻|champagne_glass 🥂|wine_glass 🍷|tumbler_glass 🥃|cocktail 🍸|tropical_drink 🍹|
soccer ⚽|basketball 🏀|football 🏈|baseball ⚾|tennis 🎾|volleyball 🏐|rugby_football 🏉|8ball 🎱|ping_pong 🏓|badminton 🏸|boxing_glove 🥊|martial_arts_uniform 🥋|skateboard 🛹|ski 🎿|trophy 🏆|first_place 🥇|second_place 🥈|third_place 🥉|medal 🏅|ticket 🎫|circus_tent 🎪|performing_arts 🎭|art 🎨|clapper 🎬|microphone 🎤|headphones 🎧|musical_score 🎼|musical_keyboard 🎹|drum 🥁|saxophone 🎷|trumpet 🎺|guitar 🎸|violin 🎻|game_die 🎲|chess_pawn ♟️|dart 🎯|bowling 🎳|video_game 🎮|gamepad 🎮|joystick 🕹️|slot_machine 🎰|jigsaw 🧩|
red_car 🚗|car 🚗|taxi 🚕|bus 🚌|police_car 🚓|ambulance 🚑|fire_engine 🚒|truck 🚚|tractor 🚜|motor_scooter 🛵|motorcycle 🏍️|bike 🚲|rotating_light 🚨|train 🚆|bullettrain_side 🚄|airplane ✈️|rocket 🚀|flying_saucer 🛸|helicopter 🚁|sailboat ⛵|ship 🚢|anchor ⚓|map 🗺️|moyai 🗿|statue_of_liberty 🗽|tokyo_tower 🗼|european_castle 🏰|ferris_wheel 🎡|roller_coaster 🎢|beach 🏖️|island 🏝️|mountain ⛰️|volcano 🌋|mount_fuji 🗻|camping 🏕️|tent ⛺|house 🏠|house_with_garden 🏡|office 🏢|hospital 🏥|bank 🏦|hotel 🏨|school 🏫|church ⛪|mosque 🕌|night_with_stars 🌃|milky_way 🌌|
watch ⌚|iphone 📱|mobile_phone 📱|computer 💻|laptop 💻|keyboard ⌨️|desktop 🖥️|printer 🖨️|mouse_three_button 🖱️|floppy_disk 💾|cd 💿|dvd 📀|camera 📷|camera_with_flash 📸|video_camera 📹|movie_camera 🎥|telephone ☎️|phone ☎️|tv 📺|radio 📻|studio_microphone 🎙️|stopwatch ⏱️|alarm_clock ⏰|hourglass ⌛|battery 🔋|electric_plug 🔌|bulb 💡|flashlight 🔦|candle 🕯️|money_with_wings 💸|dollar 💵|moneybag 💰|credit_card 💳|gem 💎|scales ⚖️|toolbox 🧰|wrench 🔧|hammer 🔨|tools 🛠️|pick ⛏️|nut_and_bolt 🔩|gear ⚙️|bricks 🧱|chains ⛓️|magnet 🧲|bomb 💣|firecracker 🧨|axe 🪓|knife 🔪|dagger 🗡️|crossed_swords ⚔️|shield 🛡️|crystal_ball 🔮|telescope 🔭|microscope 🔬|pill 💊|syringe 💉|adhesive_bandage 🩹|door 🚪|bed 🛏️|couch 🛋️|chair 🪑|toilet 🚽|shower 🚿|bathtub 🛁|key 🔑|old_key 🗝️|gift 🎁|ribbon 🎀|balloon 🎈|tada 🎉|confetti_ball 🎊|jack_o_lantern 🎃|envelope ✉️|email 📧|package 📦|mailbox 📫|page_facing_up 📄|bar_chart 📊|chart_with_upwards_trend 📈|chart_with_downwards_trend 📉|calendar 📅|clipboard 📋|file_folder 📁|newspaper 📰|notebook 📓|books 📚|book 📖|bookmark 🔖|link 🔗|paperclip 📎|straight_ruler 📏|scissors ✂️|pen 🖊️|paintbrush 🖌️|crayon 🖍️|memo 📝|pencil ✏️|pencil2 ✏️|mag 🔍|mag_right 🔎|lock 🔒|unlock 🔓|bell 🔔|no_bell 🔕|loudspeaker 📢|mega 📣|speech_balloon 💬|thought_balloon 💭|zzz 💤|
heart ❤️|red_heart ❤️|orange_heart 🧡|yellow_heart 💛|green_heart 💚|blue_heart 💙|purple_heart 💜|black_heart 🖤|white_heart 🤍|brown_heart 🤎|broken_heart 💔|heart_exclamation ❣️|two_hearts 💕|revolving_hearts 💞|heartbeat 💓|heartpulse 💗|sparkling_heart 💖|cupid 💘|gift_heart 💝|peace ☮️|yin_yang ☯️|vs 🆚|x ❌|o ⭕|stop_sign 🛑|no_entry ⛔|no_entry_sign 🚫|100 💯|hundred 💯|anger 💢|exclamation ❗|question ❓|bangbang ‼️|interrobang ⁉️|warning ⚠️|recycle ♻️|white_check_mark ✅|check ✅|heavy_check_mark ✔️|ballot_box_with_check ☑️|negative_squared_cross_mark ❎|globe_with_meridians 🌐|cyclone 🌀|information_source ℹ️|abc 🔤|ok 🆗|up 🆙|cool 🆒|new 🆕|free 🆓|sos 🆘|arrow_up ⬆️|arrow_down ⬇️|arrow_left ⬅️|arrow_right ➡️|arrows_counterclockwise 🔄|heavy_plus_sign ➕|heavy_minus_sign ➖|infinity ♾️|copyright ©️|registered ®️|tm ™️|red_circle 🔴|orange_circle 🟠|yellow_circle 🟡|green_circle 🟢|blue_circle 🔵|purple_circle 🟣|black_circle ⚫|white_circle ⚪|
white_flag 🏳️|black_flag 🏴|checkered_flag 🏁|triangular_flag_on_post 🚩|rainbow_flag 🏳️‍🌈|transgender_flag 🏳️‍⚧️|pirate_flag 🏴‍☠️|flag_th 🇹🇭|flag_jp 🇯🇵|flag_kr 🇰🇷|flag_cn 🇨🇳|flag_us 🇺🇸|flag_gb 🇬🇧|flag_fr 🇫🇷|flag_de 🇩🇪|flag_it 🇮🇹|flag_es 🇪🇸|flag_br 🇧🇷|flag_in 🇮🇳|flag_vn 🇻🇳|flag_ph 🇵🇭|flag_id 🇮🇩|flag_tr 🇹🇷
`;

/** name → emoji */
export const SHORTCODES = new Map();
/** emoji → first (canonical) name */
export const NAME_OF = new Map();

for (const entry of RAW.split('|')) {
  const trimmed = entry.trim();
  if (!trimmed) continue;
  const space = trimmed.indexOf(' ');
  const name = trimmed.slice(0, space);
  const char = trimmed.slice(space + 1).trim();
  if (!name || !char) continue;
  if (!SHORTCODES.has(name)) SHORTCODES.set(name, char);
  if (!NAME_OF.has(char)) NAME_OF.set(char, name);
}

/** The emoji for a shortcode (without colons), or undefined. */
export function emojiFor(name) {
  return SHORTCODES.get(String(name ?? '').toLowerCase());
}

/** ":thumbsup:" for 👍, or the glyph itself when it has no known name. */
export function shortcodeLabel(char) {
  const name = NAME_OF.get(char) ?? NAME_OF.get(String(char).replace(/️/g, ''));
  return name ? `:${name}:` : char;
}

/** Ranked matches for autocomplete / picker search: prefix before substring. */
export function searchShortcodes(query, limit = 40) {
  const q = String(query ?? '').toLowerCase().replace(/:/g, '');
  if (!q) return [];
  const starts = [];
  const contains = [];
  const seen = new Set();
  for (const [name, char] of SHORTCODES) {
    if (seen.has(char)) continue;
    if (name.startsWith(q)) { starts.push({ name, char }); seen.add(char); }
    else if (name.includes(q)) { contains.push({ name, char }); seen.add(char); }
  }
  return [...starts, ...contains].slice(0, limit);
}

const SHORTCODE = /(^|[^<\w]):([\w+-]{1,32}):(?!\d)/g;

/**
 * Replace `:name:` with the unicode emoji, outside code spans. Custom emoji
 * are resolved first by the caller (mentions.js), so only unknown names reach
 * here; anything that is not in the table is left exactly as typed.
 */
export function convertShortcodes(text) {
  if (!text || !text.includes(':')) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(SHORTCODE, (whole, lead, name) => {
      const char = emojiFor(name);
      return char ? `${lead}${char}` : whole;
    })))
    .join('');
}
