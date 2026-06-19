import type { UserAppearancePreference } from '@prisma/client';
import type { AppearancePreferenceDto, AppliedAppearanceDto } from '@/lib/dto/appearancePreference';
import { resolvePattern } from '@/lib/theme/types';
import { resolveStyle } from '@/lib/theme/styles';
import { resolvePalette } from '@/lib/theme/palettes';
import { resolveType } from '@/lib/theme/typography';
import { resolveAxesToApplied } from '@/lib/theme/appearance-resolution';

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
  };
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
