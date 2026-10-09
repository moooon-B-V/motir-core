import {
  FONT_SET_REGISTRY,
  FONT_SET_ROLES,
  LOCALE_FONT_SET,
  type FontSet,
  type FontSetLocale,
  type FontSetMember,
} from '@motir/design-system';
import type { UpsertUserAppearancePreferenceInput } from '@/lib/repositories/userAppearancePreferenceRepository';

// The per-locale font pick — the appearance preference's fifth axis (Story
// MOTIR-7736 · Subtask MOTIR-7894). Pure helpers over the font-set registry
// (`@motir/design-system` `theme/fontSets.ts`, MOTIR-7843), which is the ONLY
// source of truth about which ids a locale accepts: nothing here names a set or
// a member, so a member the registry gains or loses is picked up with no change.

/** The stored, still-valid picks — a locale absent from it means "automatic". */
export type FontPicks = Partial<Record<FontSetLocale, string>>;

/** An incoming patch: a member id sets the pick, `null` clears it, an omitted locale is untouched. */
export type FontPicksPatch = Partial<Record<FontSetLocale, string | null>>;

/**
 * Is `memberId` a member a person may PICK for `locale`? True only when it is
 * the id of a member in ANY role of that locale's set, and that member is a real
 * face rather than the `type-pairing` placeholder. So every Latin locale
 * (whose roles hold only `type-pairing`) accepts nothing, leaving absence as its
 * only legal state — derived from the registry, not hard-coded.
 */
export function isFontSetMemberOfLocale(locale: FontSetLocale, memberId: string): boolean {
  const set: FontSet = FONT_SET_REGISTRY[LOCALE_FONT_SET[locale]];
  return FONT_SET_ROLES.some((role) =>
    set.roles[role].members.some(
      (m: FontSetMember) => m.id === memberId && m.source.kind !== 'type-pairing',
    ),
  );
}

/**
 * Locale → the repository field that stores its pick. Total over the eleven
 * locales, and the one place the eleven field names are written.
 */
export const FONT_PICK_COLUMN = {
  en: 'fontPickEn',
  zh: 'fontPickZh',
  ja: 'fontPickJa',
  ko: 'fontPickKo',
  de: 'fontPickDe',
  fr: 'fontPickFr',
  es: 'fontPickEs',
  it: 'fontPickIt',
  nl: 'fontPickNl',
  pl: 'fontPickPl',
  pt: 'fontPickPt',
} as const satisfies Record<FontSetLocale, keyof UpsertUserAppearancePreferenceInput>;
