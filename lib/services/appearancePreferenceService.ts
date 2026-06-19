import type { UserAppearancePreference } from '@prisma/client';
import { db } from '@/lib/db';
import { userAppearancePreferenceRepository } from '@/lib/repositories/userAppearancePreferenceRepository';
import type { UpsertUserAppearancePreferenceInput } from '@/lib/repositories/userAppearancePreferenceRepository';
import {
  toAppearancePreferenceDto,
  toAppliedAppearanceDto,
} from '@/lib/mappers/appearancePreferenceMappers';
import type { AppearancePreferenceDto, AppliedAppearanceDto } from '@/lib/dto/appearancePreference';
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

/**
 * Is there a server-stored preference to honour? `true` only when a row exists
 * AND at least one axis is non-null — a row with every axis cleared (the user
 * reset everything) carries no real choice, so it is treated as "no preference"
 * and the localStorage path applies (see `getApplied`).
 */
function hasStoredPreference(row: UserAppearancePreference | null): boolean {
  if (!row) return false;
  return (
    row.pattern !== null || row.styleId !== null || row.paletteId !== null || row.typeId !== null
  );
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
   * The user's APPLIED appearance — the four `<html>` data-attribute values
   * (Subtask 7.3.61), with the type axis resolved through the style-default
   * precedence (a pinned type wins, else the active style's default). Read by
   * the root layout to render the signed-in user's real appearance on the first
   * byte (cross-device, no flash) and to seed the FOUC init script + the theme
   * context. Read-only (no `tx`).
   *
   * Returns `null` when the user has **no stored preference** (no row, or a row
   * with every axis cleared to null). This is the precedence the FOUC rule keys
   * off: the server preference is authoritative ONLY "when a server value is
   * present"; absent one, the caller falls back to the localStorage path
   * (anonymous behaviour) so a signed-in user's device-local choice is not
   * clobbered by an empty server pref. A row exists only once the user pins an
   * axis (`update`), so a freshly-seeded user resolves to `null` here.
   */
  async getApplied(userId: string): Promise<AppliedAppearanceDto | null> {
    const row = await userAppearancePreferenceRepository.findByUserId(userId);
    if (!hasStoredPreference(row)) return null;
    return toAppliedAppearanceDto(row);
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
