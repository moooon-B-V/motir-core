import { Prisma } from '@prisma/client';
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
