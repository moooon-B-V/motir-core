import type { UserAppearancePreference } from '@/generated/prisma/client';
import type { AppearancePreferenceDto, AppliedAppearanceDto } from '@/lib/dto/appearancePreference';
import { resolvePattern } from '@/lib/theme/types';
import { resolveStyle } from '@/lib/theme/styles';
import { resolvePalette } from '@/lib/theme/palettes';
import { resolveType } from '@/lib/theme/typography';
import { resolveAxesToApplied } from '@/lib/theme/appearance-resolution';
import { FONT_SET_LOCALES, fontSetPickAttributes } from '@motir/design-system';
import {
  FONT_PICK_COLUMN,
  isFontSetMemberOfLocale,
  type AppliedFontSetAttrs,
  type FontPicks,
} from '@/lib/appearance/fontPicks';

// Prisma → DTO mapping for the appearance-preference surface (Story 7.3 ·
// Subtask 7.3.60). The single place absence + stale values collapse to the
// documented defaults: a `null` row (the user has pinned nothing) and any
// null / stale column both RESOLVE per axis through the theme registries
// (`resolvePattern` / `resolveStyle` / `resolvePalette` / `resolveType`), so
// the DTO always carries four concrete, valid ids. The registry is the source
// of truth — a value that is no longer a registered id resolves to its
// default rather than leaking out.

/** Resolve a stored row (or its absence) to the four-axis DTO. */
export function toAppearancePreferenceDto(
  row: UserAppearancePreference | null,
): AppearancePreferenceDto {
  return {
    pattern: resolvePattern(row?.pattern),
    styleId: resolveStyle(row?.styleId).id,
    paletteId: resolvePalette(row?.paletteId).id,
    typeId: resolveType(row?.typeId).id,
    fontPicks: toFontPicks(row),
  };
}

/**
 * The stored per-locale font picks (Story MOTIR-7736) that are still members
 * of their locale's set. A null column is automatic and a stale member (one
 * that has since left the registry) is dropped, so it too reads as automatic —
 * the same collapse the four axes above get.
 */
function toFontPicks(row: UserAppearancePreference | null): FontPicks {
  const picks: FontPicks = {};
  if (!row) return picks;
  for (const locale of FONT_SET_LOCALES) {
    const value = row[FONT_PICK_COLUMN[locale]];
    if (value !== null && isFontSetMemberOfLocale(locale, value)) picks[locale] = value;
  }
  return picks;
}

/**
 * The `<html>` attributes each locale's stored pick puts on a page in that
 * language (MOTIR-7896). A null or stale value, a default member and every
 * Latin locale contribute no entry, so the `:lang()` block's set default draws;
 * the roles come from `fontSetPickAttributes`, the derivation the client's
 * `setFontPick` uses, so both sides stamp identical attributes for one pick.
 */
export function toAppliedFontSetAttrs(row: UserAppearancePreference | null): AppliedFontSetAttrs {
  const attrs: AppliedFontSetAttrs = {};
  if (!row) return attrs;
  for (const locale of FONT_SET_LOCALES) {
    const value = row[FONT_PICK_COLUMN[locale]];
    if (value === null || !isFontSetMemberOfLocale(locale, value)) continue;
    const entry = fontSetPickAttributes(locale, value);
    if (Object.keys(entry).length > 0) attrs[locale] = entry;
  }
  return attrs;
}

/**
 * Resolve a stored row (or its absence) to the APPLIED appearance — the shape
 * that drives the `<html>` data-attributes (Subtask 7.3.61). Unlike
 * {@link toAppearancePreferenceDto}, the type axis follows the active style's
 * default when the user has pinned no type (delegated to the registry-pure
 * `resolveAxesToApplied`, shared with the client's anonymous path).
 */
export function toAppliedAppearanceDto(row: UserAppearancePreference | null): AppliedAppearanceDto {
  return resolveAxesToApplied({
    pattern: row?.pattern,
    styleId: row?.styleId,
    paletteId: row?.paletteId,
    typeId: row?.typeId,
  });
}
