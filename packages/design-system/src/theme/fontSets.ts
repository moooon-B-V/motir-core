/**
 * The Motir FONT-SET REGISTRY: which faces each locale's script is drawn in
 * (Story MOTIR-7733 · Subtask MOTIR-7843).
 *
 * A Type pairing (`./typography.ts`) decides the LATIN faces of the three roles
 * (sans / serif / mono). A font set decides the SCRIPT face that sits BEHIND
 * them, so a ja page draws its Latin in the pairing's face and its kana and
 * kanji in the ja set's face, under every pairing. The two axes are
 * independent: a set never changes which pairing is active, and a pairing never
 * changes which set a locale uses.
 *
 * ── Where the rows come from ────────────────────────────────────────────
 * Every set, member and default below is taken from
 * `docs/typography/font-sets.md` (MOTIR-7841), which read dooooWeb's mapping at
 * `225af77` and filled the roles dooooWeb leaves empty from cited references.
 * `inDooooWeb` carries that document's `in dooooWeb` / `added (not in dooooWeb)`
 * tag. Change a row here only together with that document; the package test
 * holds the two equal.
 *
 * ── What this module is NOT ─────────────────────────────────────────────
 * Data and pure resolvers only. It names CSS custom properties (the contract
 * between the app's `next/font` loader and `theme.css`) but sets none, loads no
 * face, and writes no CSS. Loading stays in the consuming app.
 */

/** The eleven locales app.motir.co ships in. A closed product decision. */
export const FONT_SET_LOCALES = [
  'en',
  'zh',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'pl',
  'pt',
] as const;

/** A locale the font-set registry knows. */
export type FontSetLocale = (typeof FONT_SET_LOCALES)[number];

/** The three type roles every set covers: the same roles `--font-*` carries. */
export const FONT_SET_ROLES = ['sans', 'serif', 'mono'] as const;

/** One of the three type roles. */
export type FontSetRole = (typeof FONT_SET_ROLES)[number];

/**
 * Where a member's face comes from.
 *
 * - `type-pairing`: the active Type pairing's own face for the role. The Latin
 *   set's only member; it loads nothing and has no CSS variable.
 * - `next/font/google`: a Google Fonts face the app loads with `next/font`;
 *   `googleFamily` is the loader's export name (`Noto_Sans_JP`).
 */
export type FontSetMemberSource =
  | { readonly kind: 'type-pairing' }
  | { readonly kind: 'next/font/google'; readonly googleFamily: string };

/** One selectable face in one role of one set. */
export interface FontSetMember {
  /** Stable kebab-case slug, unique within its role. The value a pick stores. */
  readonly id: string;
  /** The display name, or `null` for the `type-pairing` member. */
  readonly family: string | null;
  readonly source: FontSetMemberSource;
  /** `docs/typography/font-sets.md`'s tag: `in dooooWeb` (true) or `added` (false). */
  readonly inDooooWeb: boolean;
  /**
   * The role whose member of the SAME id this member re-uses the face of. A
   * CJK set's mono role draws its Han glyphs from the set's sans face (the Noto
   * Sans Mono CJK practice, see the doc), so the face is loaded once and both
   * roles read one variable.
   */
  readonly sameFaceAs?: FontSetRole;
}

/** One role of one set: its members, and which one a page uses by default. */
export interface FontSetRoleMembers {
  /** The id of the member used when nobody has picked one. */
  readonly default: string;
  readonly members: readonly FontSetMember[];
}

/** A locale group's font set. */
export interface FontSet {
  readonly id: string;
  /** Display name for `/tokens` and the picker. */
  readonly label: string;
  /**
   * The BCP 47 tag the set's `:lang()` rule matches. It is the tag the app
   * renders on `<html lang>` (`zh`, not `zh-Hans`), because `:lang(zh)`
   * matches `zh` and `zh-Hans` while `:lang(zh-Hans)` does not match `zh`.
   * `null` for the Latin set, which is matched by its locales instead.
   */
  readonly lang: string | null;
  /** True for a CJK set: its faces are unicode-range sliced and never preloaded. */
  readonly cjk: boolean;
  readonly roles: Readonly<Record<FontSetRole, FontSetRoleMembers>>;
}

const TYPE_PAIRING: FontSetMember = {
  id: 'type-pairing',
  family: null,
  source: { kind: 'type-pairing' },
  inDooooWeb: false,
};

function google(
  id: string,
  family: string,
  inDooooWeb: boolean,
  sameFaceAs?: FontSetRole,
): FontSetMember {
  return {
    id,
    family,
    source: { kind: 'next/font/google', googleFamily: family.replace(/ /g, '_') },
    inDooooWeb,
    ...(sameFaceAs ? { sameFaceAs } : {}),
  };
}

/**
 * The registry, one entry per set. Ids are the doc's registry ids; dooooWeb's
 * own group names are noted beside each.
 */
export const FONT_SET_REGISTRY = {
  // dooooWeb: `latin`. Its Latin picker faces are deliberately not members:
  // behind the pairing's face they would never draw a glyph (font-sets.md § latin).
  latin: {
    id: 'latin',
    label: 'Latin',
    lang: null,
    cjk: false,
    roles: {
      sans: { default: 'type-pairing', members: [TYPE_PAIRING] },
      serif: { default: 'type-pairing', members: [TYPE_PAIRING] },
      mono: { default: 'type-pairing', members: [TYPE_PAIRING] },
    },
  },
  // dooooWeb: `chinese-simplified`.
  'zh-Hans': {
    id: 'zh-Hans',
    label: 'Simplified Chinese',
    lang: 'zh',
    cjk: true,
    roles: {
      sans: { default: 'noto-sans-sc', members: [google('noto-sans-sc', 'Noto Sans SC', false)] },
      serif: {
        default: 'noto-serif-sc',
        members: [
          google('noto-serif-sc', 'Noto Serif SC', true),
          // Draws Traditional / inherited forms, so never the default (font-sets.md § Region forms).
          google('lxgw-wenkai-tc', 'LXGW WenKai TC', true),
        ],
      },
      mono: {
        default: 'noto-sans-sc',
        members: [google('noto-sans-sc', 'Noto Sans SC', false, 'sans')],
      },
    },
  },
  // dooooWeb: `japanese`.
  ja: {
    id: 'ja',
    label: 'Japanese',
    lang: 'ja',
    cjk: true,
    roles: {
      sans: {
        default: 'noto-sans-jp',
        members: [
          google('noto-sans-jp', 'Noto Sans JP', true),
          google('m-plus-rounded-1c', 'M PLUS Rounded 1c', true),
        ],
      },
      serif: {
        default: 'noto-serif-jp',
        members: [google('noto-serif-jp', 'Noto Serif JP', false)],
      },
      mono: {
        default: 'noto-sans-jp',
        members: [google('noto-sans-jp', 'Noto Sans JP', false, 'sans')],
      },
    },
  },
  // dooooWeb: `korean`.
  ko: {
    id: 'ko',
    label: 'Korean',
    lang: 'ko',
    cjk: true,
    roles: {
      sans: {
        default: 'noto-sans-kr',
        members: [
          google('noto-sans-kr', 'Noto Sans KR', true),
          google('nanum-gothic', 'Nanum Gothic', true),
        ],
      },
      serif: {
        default: 'noto-serif-kr',
        members: [google('noto-serif-kr', 'Noto Serif KR', false)],
      },
      mono: {
        default: 'noto-sans-kr',
        members: [google('noto-sans-kr', 'Noto Sans KR', false, 'sans')],
      },
    },
  },
} as const satisfies Record<string, FontSet>;

/** The id of every registered set. */
export type FontSetId = keyof typeof FONT_SET_REGISTRY;

/** All set ids, in registry order. */
export const FONT_SET_IDS = Object.keys(FONT_SET_REGISTRY) as FontSetId[];

/** The set an unknown or empty page language falls back to: the app renders it in English. */
export const DEFAULT_FONT_SET_ID: FontSetId = 'latin';

/** Which set each locale is drawn in (font-sets.md § Locale → set). */
export const LOCALE_FONT_SET = {
  en: 'latin',
  zh: 'zh-Hans',
  ja: 'ja',
  ko: 'ko',
  de: 'latin',
  fr: 'latin',
  es: 'latin',
  it: 'latin',
  nl: 'latin',
  pl: 'latin',
  pt: 'latin',
} as const satisfies Record<FontSetLocale, FontSetId>;

/** Narrowing guard: is an arbitrary value one of the eleven locales? */
export function isFontSetLocale(value: unknown): value is FontSetLocale {
  return typeof value === 'string' && (FONT_SET_LOCALES as readonly string[]).includes(value);
}

/**
 * The set for an `<html lang>` value. Matches the primary subtag
 * case-insensitively (`ja-JP` → ja, `PT-br` → pt, `zh-Hans` → zh).
 *
 * The fallback is explicit: an empty or unknown tag returns the Latin set,
 * because the app renders an unknown language in English. It never falls back
 * to "the nearest CJK set". Use `isFontSetLocale` on the primary subtag to tell
 * a fallback from a match.
 */
export function resolveFontSet(lang: string): FontSet {
  const primary = lang.trim().split(/[-_]/)[0]?.toLowerCase() ?? '';
  const id = isFontSetLocale(primary) ? LOCALE_FONT_SET[primary] : DEFAULT_FONT_SET_ID;
  return FONT_SET_REGISTRY[id];
}

/**
 * A member of one role of one set, by id. A missing or unknown id (a stored
 * pick naming a member that has since been removed) returns that role's
 * default, never another set's face.
 */
export function resolveFontSetMember(
  setId: FontSetId,
  role: FontSetRole,
  memberId?: string,
): FontSetMember {
  const r: FontSetRoleMembers = FONT_SET_REGISTRY[setId].roles[role];
  const named = memberId === undefined ? undefined : r.members.find((m) => m.id === memberId);
  return named ?? r.members.find((m) => m.id === r.default)!;
}

/**
 * The CSS custom property the app's `next/font` loader assigns to a member's
 * face and `theme.css` reads: `--font-set-<set>-<role>-<member>`. This name is
 * the contract between the registry, the loader and the stylesheet, so it is
 * built here and nowhere else.
 *
 * A member that re-uses another role's face (`sameFaceAs`) returns THAT role's
 * variable, so the face is declared once. The `type-pairing` member, and an id
 * the role does not have, return `null`.
 */
export function fontSetMemberVar(
  setId: FontSetId,
  role: FontSetRole,
  memberId: string,
): string | null {
  const member = FONT_SET_REGISTRY[setId].roles[role].members.find(
    (m: FontSetMember) => m.id === memberId,
  );
  if (!member || member.source.kind === 'type-pairing') return null;
  const faceRole = member.sameFaceAs ?? role;
  return `--font-set-${setId}-${faceRole}-${member.id}`;
}

/** The `<html>` attribute that names a picked member for one role. */
export type FontSetPickAttribute = `data-font-set-${FontSetRole}`;

/**
 * The `data-font-set-<role>` attributes a person's pick for `locale` puts on
 * `<html>` (Story MOTIR-7736 · MOTIR-7897). One attribute per role of the
 * locale's set that has a member with this id, unless that member is the
 * `type-pairing` placeholder or the role's default: `theme.css` carries a rule
 * only for a non-default member, so a default needs no attribute.
 *
 * `null`, an unknown id, a default id and every Latin locale return `{}`. This
 * is the ONE derivation the client (`setFontPick`) and the server-rendered
 * first byte share, so a pick sets identical attributes on both sides — which
 * is why it lives here, free of any `'use client'` boundary.
 */
export function fontSetPickAttributes(
  locale: FontSetLocale,
  memberId: string | null,
): Partial<Record<FontSetPickAttribute, string>> {
  if (memberId === null) return {};
  const set: FontSet = FONT_SET_REGISTRY[LOCALE_FONT_SET[locale]];
  const attrs: Partial<Record<FontSetPickAttribute, string>> = {};
  for (const role of FONT_SET_ROLES) {
    const r: FontSetRoleMembers = set.roles[role];
    if (memberId === r.default) continue;
    const member = r.members.find((m: FontSetMember) => m.id === memberId);
    if (member && member.source.kind !== 'type-pairing') attrs[`data-font-set-${role}`] = memberId;
  }
  return attrs;
}
