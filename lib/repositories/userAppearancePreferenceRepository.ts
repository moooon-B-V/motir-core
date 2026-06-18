import { Prisma, type UserAppearancePreference } from '@prisma/client';
import { db } from '@/lib/db';

// User-appearance-preference repository — single Prisma operations on the
// `user_appearance_preference` table (Story 7.3 · Subtask 7.3.59). The
// persistence leaf the appearance service (7.3.60) reads (resolve the user's
// pinned axes) and writes (the settings-panel upsert). The SERVICE is the
// authority for transactions, validation, axis defaults, and DTO mapping; this
// leaf holds none of that.
//
// Layer rules (CLAUDE.md): the write (`upsert`) REQUIRES `tx`; the pure read
// (`findByUserId`) uses the `db` singleton. No business logic, no transactions,
// no DTO mapping.
//
// A row exists ONLY for a user who has explicitly pinned at least one axis —
// absence means "use the documented default for every axis" (resolved in the
// service), so reads never assume a row is present (the `NotificationPreference`
// absence-semantics).

/**
 * The patch an `upsert` applies — any subset of the four axes. An `undefined`
 * field is left untouched; passing `null` explicitly clears an axis back to its
 * default. The service validates each value before it reaches here.
 */
export interface UpsertUserAppearancePreferenceInput {
  pattern?: string | null;
  styleId?: string | null;
  paletteId?: string | null;
  typeId?: string | null;
}

export const userAppearancePreferenceRepository = {
  /** A user's stored appearance row, or null when they've pinned nothing yet. */
  async findByUserId(userId: string): Promise<UserAppearancePreference | null> {
    return db.userAppearancePreference.findUnique({ where: { userId } });
  },

  /**
   * Insert the user's row on first pin, patch it thereafter (keyed on the 1:1
   * `userId @unique`). Required `tx` (rides the service transaction).
   * Idempotent by construction: re-applying the same patch is a no-op update.
   */
  async upsert(
    userId: string,
    patch: UpsertUserAppearancePreferenceInput,
    tx: Prisma.TransactionClient,
  ): Promise<UserAppearancePreference> {
    return tx.userAppearancePreference.upsert({
      where: { userId },
      create: { userId, ...patch },
      update: patch,
    });
  },
};
