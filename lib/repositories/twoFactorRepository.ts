import type { Prisma, TwoFactor } from '@/generated/prisma/client';
import { db } from '@/lib/db';

// Data access for the `two_factor` table (Story MOTIR-1213 · Subtask
// MOTIR-1218). Single Prisma operations only; no business logic, no
// transactions of its own (CLAUDE.md § 4-layer).
//
// The table is Better-Auth's — its adapter reads and writes the same rows — so
// nothing here may reshape a row. What this repository adds is the ONE access
// pattern the plugin's adapter cannot express: a `SELECT … FOR UPDATE` on the
// caller's own enrolment, which is what makes spending a recovery code
// race-safe rather than merely usually-correct.

export const twoFactorRepository = {
  /**
   * The user's enrolment row, or null. Read-only path (the status pane), so the
   * `db` singleton rather than a `tx`.
   *
   * `findFirst`, not `findUnique`: `userId` is indexed and deliberately NOT
   * unique (see the model's doc comment), so the type system would not offer a
   * unique lookup even though the plugin keeps at most one row per user.
   */
  async findByUserId(userId: string): Promise<TwoFactor | null> {
    return db.twoFactor.findFirst({ where: { userId } });
  },

  /**
   * The user's enrolment row, LOCKED `FOR UPDATE` inside the caller's
   * transaction — the race-safe read that every recovery-code write derives
   * from (lock-before-read-derived-update, CLAUDE.md § 4-layer).
   *
   * WHY THE LOCK IS NOT OPTIONAL HERE. Spending a recovery code is a
   * read-derived write of the worst kind: the whole unspent SET lives in ONE
   * column, so "use this code" is decrypt → remove one member → re-encrypt →
   * write the whole column back. Two transactions that both read the column
   * before either writes will each compute a set missing only THEIR code, and
   * the second write silently restores the first's code to the unspent set — a
   * single-use credential that can be used twice. Locking the row serialises
   * them: the second blocks until the first commits, then re-reads the already
   * shortened set and correctly finds its own code missing (or present, if it
   * was a different one).
   *
   * `ORDER BY "id"` pins a deterministic lock-acquisition order so two callers
   * that somehow see more than one row for a user cannot deadlock — the same
   * reasoning as `organizationMembershipRepository.countOwnersByOrgForUpdate`.
   *
   * `tx` REQUIRED: a row lock only lives for its transaction, so a caller
   * without one would take a lock and drop it on the next statement.
   */
  async findByUserIdForUpdate(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; backupCodes: string; verified: boolean } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; backupCodes: string; verified: boolean }>>`
      SELECT "id", "backup_codes" AS "backupCodes", "verified"
        FROM "two_factor"
       WHERE "user_id" = ${userId}
       ORDER BY "id"
       FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /** Replace the stored recovery-code column. Write → `tx` required. */
  async updateBackupCodes(
    id: string,
    backupCodes: string,
    tx: Prisma.TransactionClient,
  ): Promise<TwoFactor> {
    return tx.twoFactor.update({ where: { id }, data: { backupCodes } });
  },

  /** Drop every enrolment row for a user (disabling 2FA). Write → `tx` required. */
  async deleteByUserId(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.twoFactor.deleteMany({ where: { userId } });
    return result.count;
  },
};
