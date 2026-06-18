import { db } from '@/lib/db';
import { userAppearancePreferenceRepository } from '@/lib/repositories/userAppearancePreferenceRepository';
import type { UpsertUserAppearancePreferenceInput } from '@/lib/repositories/userAppearancePreferenceRepository';
import { toAppearancePreferenceDto } from '@/lib/mappers/appearancePreferenceMappers';
import type { AppearancePreferenceDto } from '@/lib/dto/appearancePreference';
import { InvalidAppearanceValueError } from '@/lib/appearance/errors';
import { isThemePattern } from '@/lib/theme/types';
import { isStyleId } from '@/lib/theme/styles';
import { isPaletteId } from '@/lib/theme/palettes';
import { isTypeId } from '@/lib/theme/typography';

// Cross-device appearance preferences (Story 7.3 · Subtask 7.3.60) — the
// business logic behind the account-settings Appearance pane (7.3.62) and the
// no-flash SSR application layer (7.3.61). Personal settings, scoped to one
// user (no workspace context — appearance applies across every workspace), the
// `notificationPreferencesService` shape.
//
// The theme REGISTRIES are the source of truth (CLAUDE.md decision-ladder rung
// 2): `update` validates every incoming id against `isStyleId` / `isPaletteId`
// / `isTypeId` / `isThemePattern` and rejects an unknown one with a typed
// `InvalidAppearanceValueError` — a stale client value is NEVER stored. Reads
// resolve absence + any historically-stale stored value to the documented
// default (the mapper), so `getResolved` always returns four valid ids.
//
// 4-layer: this SERVICE owns validation, the write transaction, and DTO
// mapping; the repository is the single-op leaf. `null` clears an axis back to
// its default; `undefined` leaves it untouched (the partial-patch contract).

/** The partial patch the Appearance pane sends — any subset of the four axes. */
export interface AppearancePreferencePatch {
  pattern?: string | null;
  styleId?: string | null;
  paletteId?: string | null;
  typeId?: string | null;
}

/**
 * Validate one optional axis value: `undefined` (untouched) and `null` (clear
 * to default) both pass through; a provided string is checked against its
 * registry guard and throws `InvalidAppearanceValueError` when unknown.
 */
function validateAxis(
  axis: 'pattern' | 'styleId' | 'paletteId' | 'typeId',
  value: string | null | undefined,
  guard: (v: unknown) => boolean,
): void {
  if (value === undefined || value === null) return;
  if (!guard(value)) throw new InvalidAppearanceValueError(axis, value);
}

export const appearancePreferenceService = {
  /**
   * The current user's appearance preference with every axis RESOLVED to a
   * valid id (the stored value, or the documented default when unset / no row).
   * Read-only (no `tx`).
   */
  async getResolved(userId: string): Promise<AppearancePreferenceDto> {
    const row = await userAppearancePreferenceRepository.findByUserId(userId);
    return toAppearancePreferenceDto(row);
  },

  /**
   * Apply a partial patch: validate each provided axis against its registry,
   * then upsert in ONE transaction. Returns the resolved preference so the
   * client updates from the RESPONSE (the inline-edit-no-tree-refresh
   * contract). Throws `InvalidAppearanceValueError` on an unknown id (nothing
   * is written).
   */
  async update(userId: string, patch: AppearancePreferencePatch): Promise<AppearancePreferenceDto> {
    validateAxis('pattern', patch.pattern, isThemePattern);
    validateAxis('styleId', patch.styleId, isStyleId);
    validateAxis('paletteId', patch.paletteId, isPaletteId);
    validateAxis('typeId', patch.typeId, isTypeId);

    // Only carry the axes the caller actually provided — `undefined` keys must
    // not reach the upsert (they'd clobber a stored value with "no change" vs.
    // an explicit `null` clear, which Prisma treats identically; omitting them
    // keeps the partial-patch semantics unambiguous).
    const repoPatch: UpsertUserAppearancePreferenceInput = {};
    if (patch.pattern !== undefined) repoPatch.pattern = patch.pattern;
    if (patch.styleId !== undefined) repoPatch.styleId = patch.styleId;
    if (patch.paletteId !== undefined) repoPatch.paletteId = patch.paletteId;
    if (patch.typeId !== undefined) repoPatch.typeId = patch.typeId;

    const row = await db.$transaction((tx) =>
      userAppearancePreferenceRepository.upsert(userId, repoPatch, tx),
    );
    return toAppearancePreferenceDto(row);
  },
};
