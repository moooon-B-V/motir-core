import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';

// Session repository — single Prisma operations on the `session` table
// (Better-Auth's session rows: one per signed-in device/browser, keyed by a
// unique `token`).

export const sessionRepository = {
  /**
   * Count the user's active sessions. Read-only path — no `tx`. Used by tests
   * and by callers that want to know whether "revoke other sessions" would do
   * anything.
   */
  async countByUserId(userId: string): Promise<number> {
    return db.session.count({ where: { userId } });
  },

  /**
   * Delete EVERY session the user holds — the sign-out half of scheduling an
   * account deletion (Story 8.4 · Subtask MOTIR-3700).
   *
   * Design DECISION 4: *"The account closes immediately — the reader is signed
   * out and the account stops being usable by anyone else — and the erasure
   * runs 30 days later."* The grace period is about the DATA, not about
   * continued access, so every open device goes at once; there is no session to
   * keep, which is what separates this from {@link deleteOthersForUser}.
   *
   * ⚠️ ITS CALLER RUNS IT AFTER THE SCHEDULING TRANSACTION HAS COMMITTED, in
   * its own transaction and its own try/catch. It still takes `tx` because it
   * is a write and the repository contract requires one — the "outside the
   * transaction" in `accountDeletionService` means outside the transaction that
   * decided the deletion, not outside any transaction at all.
   *
   * Returns the number of sessions removed.
   */
  async deleteAllForUser(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.session.deleteMany({ where: { userId } });
    return result.count;
  },

  /**
   * Delete every session for the user EXCEPT the one identified by
   * `keepToken` (the caller's current session). This powers the
   * change-password "revoke other sessions" option: the current browser stays
   * signed in (no cookie rotation needed) while every other device is logged
   * out. Write — requires `tx`. Returns the number of sessions removed.
   */
  async deleteOthersForUser(
    userId: string,
    keepToken: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.session.deleteMany({
      where: { userId, token: { not: keepToken } },
    });
    return result.count;
  },
};
