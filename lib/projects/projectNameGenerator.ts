// The generated name a workspace's first project is seeded with
// (Story MOTIR-8239 · Subtask MOTIR-8526) — "quiet-harbor-4821" rather than a
// copy of the workspace's name.
//
// ⚠️ IT IS MEANT TO LOOK RANDOM. Lowercase, hyphenated, with a four-digit
// number on the end: the shape says "a placeholder somebody drew for you", so
// the person goes to project settings and renames it (Mo's design refusal on
// MOTIR-8532, format chosen 2026-10-14). The name is deliberately NOT shown on
// the onboarding entrance.
//
// ⚠️ PURE, AND IMPORT-FREE ON PURPOSE. Two curated lists and one draw, nothing
// else: no Prisma client, no message catalog, no locale. A service, a script
// and a unit test can all load it, the same reason `lib/projects/errors.ts`
// lives in its own file. The module stops at the NAME — deriving the
// identifier and the slug, re-drawing on a collision and the suffix fallback
// all belong to the seeding in `projectsService.ensureDefaultProject`.
//
// ⚠️ ONE ENGLISH LIST FOR ALL ELEVEN APP LANGUAGES. The name is the person's
// own data rather than product copy: it is expected to be renamed, it must
// survive `deriveIdentifierBase`'s A–Z/0–9 identifier and become a URL slug,
// and the same pair reads the same in every locale. So there is no locale
// argument and no per-locale list.
//
// ⚠️ THE LISTS ARE DATA, NOT LOGIC. The draw does not filter, dedupe or
// re-draw, so what the word-list review reads is exactly what a person
// receives, and a rejected word is a one-line edit to an array. Every entry is
// lowercase ASCII, three letters or more (`^[a-z]{3,}$`), and each list has
// at least 100 entries — all asserted by
// `tests/projects/projectNameGenerator.test.ts` over these exported arrays.
//
// Every ADJECTIVE is at least five letters long. The identifier is the first
// five A–Z characters of the whole name, so a five-letter-or-longer adjective
// makes the key the adjective's own opening ("quiet-harbor-4821" → QUIET) rather
// than a fragment spliced across the two words — and the wider the spread of
// adjective openings, the more often a collision re-draw lands on a free key.

export const PROJECT_NAME_ADJECTIVES: readonly string[] = [
  'amber',
  'amiable',
  'ancient',
  'autumn',
  'bouncy',
  'breezy',
  'bright',
  'brisk',
  'bubbly',
  'candid',
  'cheerful',
  'clever',
  'coastal',
  'cobalt',
  'copper',
  'cosmic',
  'crimson',
  'crisp',
  'curious',
  'dainty',
  'dapper',
  'daring',
  'distant',
  'dreamy',
  'dusky',
  'eager',
  'early',
  'earnest',
  'eastern',
  'electric',
  'emerald',
  'endless',
  'evening',
  'fabled',
  'faithful',
  'fearless',
  'festive',
  'fluent',
  'fresh',
  'frosty',
  'gentle',
  'gilded',
  'gleaming',
  'golden',
  'graceful',
  'grand',
  'hearty',
  'hidden',
  'honest',
  'humble',
  'indigo',
  'inland',
  'ivory',
  'jaunty',
  'jolly',
  'jovial',
  'joyful',
  'kindly',
  'lively',
  'lofty',
  'lucky',
  'lunar',
  'mellow',
  'merry',
  'mighty',
  'misty',
  'modest',
  'morning',
  'mossy',
  'nifty',
  'nimble',
  'noble',
  'northern',
  'novel',
  'orange',
  'patient',
  'peaceful',
  'plucky',
  'polar',
  'proud',
  'purple',
  'quaint',
  'quiet',
  'radiant',
  'rapid',
  'regal',
  'royal',
  'rustic',
  'scarlet',
  'serene',
  'shiny',
  'silent',
  'silver',
  'simple',
  'sincere',
  'sleek',
  'smooth',
  'snowy',
  'solar',
  'sonic',
  'southern',
  'spirited',
  'steady',
  'stellar',
  'stout',
  'sturdy',
  'summer',
  'sunlit',
  'swift',
  'tender',
  'thrifty',
  'tidal',
  'tranquil',
  'trusty',
  'twilight',
  'upbeat',
  'urban',
  'valiant',
  'verdant',
  'vernal',
  'vivid',
  'western',
  'whimsical',
  'windy',
  'winter',
  'wistful',
  'witty',
  'wooden',
  'woven',
  'zesty',
];

export const PROJECT_NAME_NOUNS: readonly string[] = [
  'acorn',
  'anchor',
  'aspen',
  'atlas',
  'aurora',
  'badger',
  'banjo',
  'beacon',
  'beaver',
  'birch',
  'bison',
  'breeze',
  'bridge',
  'brook',
  'canvas',
  'canyon',
  'cascade',
  'castle',
  'cedar',
  'cello',
  'citadel',
  'clover',
  'comet',
  'compass',
  'condor',
  'cottage',
  'crane',
  'creek',
  'delta',
  'dolphin',
  'dune',
  'eagle',
  'echo',
  'ember',
  'fable',
  'falcon',
  'feather',
  'fern',
  'finch',
  'fjord',
  'forest',
  'fox',
  'galaxy',
  'garden',
  'gecko',
  'glacier',
  'granite',
  'grove',
  'harbor',
  'harvest',
  'hawk',
  'heron',
  'horizon',
  'ibis',
  'island',
  'jaguar',
  'journey',
  'kettle',
  'kite',
  'koala',
  'ladder',
  'lagoon',
  'lake',
  'lantern',
  'lotus',
  'lynx',
  'magpie',
  'maple',
  'marsh',
  'meadow',
  'melody',
  'mesa',
  'meteor',
  'moose',
  'mosaic',
  'nebula',
  'oak',
  'oasis',
  'orbit',
  'orchard',
  'orchid',
  'osprey',
  'otter',
  'owl',
  'panda',
  'pebble',
  'pelican',
  'penguin',
  'piano',
  'pine',
  'pioneer',
  'planet',
  'poppy',
  'prairie',
  'prism',
  'puffin',
  'puzzle',
  'quartz',
  'quill',
  'rainbow',
  'raven',
  'reef',
  'ribbon',
  'riddle',
  'ridge',
  'river',
  'rocket',
  'saddle',
  'sail',
  'salmon',
  'sextant',
  'shore',
  'signal',
  'sonnet',
  'sparrow',
  'stream',
  'summit',
  'sunrise',
  'swan',
  'telescope',
  'thistle',
  'thunder',
  'tide',
  'tiger',
  'timber',
  'tower',
  'tulip',
  'tundra',
  'turtle',
  'valley',
  'voyage',
  'walrus',
  'whistle',
  'willow',
  'wolf',
  'wren',
  'yak',
  'zebra',
  'zephyr',
];

/** The four-digit number's range: 1000–9999, so it always reads as four digits. */
export const PROJECT_NAME_NUMBER_MIN = 1000;
export const PROJECT_NAME_NUMBER_MAX = 9999;

/**
 * Draw one adjective, one noun and one four-digit number and return them
 * lowercase and joined by hyphens — `quiet-harbor-4821`.
 *
 * `random` is the ONLY source of randomness (the repository's shipped pattern,
 * `retryBackoffMs` in `lib/jobs/engine/worker.ts`), read exactly three times
 * per call: adjective, noun, number. So a pinned source pins the name, which
 * is what the seeding's collision and exhaustion tests rely on.
 *
 * Each index is clamped to its range: `Math.random` never returns 1, but an
 * injected source may, and `Math.floor(1 * length)` would index past the end
 * and yield `undefined` on a path that must not fail.
 */
export function generateProjectName(random: () => number = Math.random): string {
  const adjective = pick(PROJECT_NAME_ADJECTIVES, random());
  const noun = pick(PROJECT_NAME_NOUNS, random());
  const span = PROJECT_NAME_NUMBER_MAX - PROJECT_NAME_NUMBER_MIN + 1;
  const number = PROJECT_NAME_NUMBER_MIN + clampIndex(random(), span);
  return `${adjective}-${noun}-${number}`;
}

function pick(list: readonly string[], r: number): string {
  return list[clampIndex(r, list.length)]!;
}

function clampIndex(r: number, length: number): number {
  return Math.min(length - 1, Math.max(0, Math.floor(r * length)));
}
