import { Prisma, type EmailChangeRequest } from '@prisma/client';
import { db } from '@/lib/db';

// Email-change-request repository (Subtask 8.8.22) — single Prisma operations on
// the `email_change_request` table. Per CLAUDE.md: write methods require
// `tx: Prisma.TransactionClient`; reads that guard a subsequent write inside the
// same transaction take `tx` too. No business logic, no transactions here —
// `usersService.requestEmailChange` / `confirmEmailChange` own those.

export const emailChangeRequestRepository = {
  /**
   * Insert a pending request. The `new_email` unique index is the race guard:
   * a second concurrent insert for the same address throws `P2002`, which the
   * service catches and rethrows as `EmailTakenError`.
   */
  async create(
    data: { userId: string; newEmail: string; token: string; expiresAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<EmailChangeRequest> {
    return tx.emailChangeRequest.create({ data });
  },

  /**
   * Resolve a request by its opaque token. Used inside the confirm transaction
   * to read the (userId, newEmail) it authorises before swapping the email, so
   * it takes `tx`.
   */
  async findByToken(
    token: string,
    tx: Prisma.TransactionClient,
  ): Promise<EmailChangeRequest | null> {
    return tx.emailChangeRequest.findUnique({ where: { token } });
  },

  /** Single-use delete of a consumed token. Returns the rows removed (0 or 1). */
  async deleteByToken(token: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.emailChangeRequest.deleteMany({ where: { token } });
    return r.count;
  },

  /**
   * Clear any row that would make a fresh request for `newEmail` spuriously lose
   * the unique race against a STALE claim: the requesting user's own prior claim
   * on this address (so re-requesting it is idempotent) and ANY expired claim on
   * it (an abandoned request past its 1h window must not lock the address
   * forever). A live claim by a DIFFERENT user is left intact — that is the real
   * contention the unique index must still reject.
   */
  async clearReusableForEmail(
    args: { userId: string; newEmail: string; now: Date },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.emailChangeRequest.deleteMany({
      where: {
        newEmail: args.newEmail,
        OR: [{ userId: args.userId }, { expiresAt: { lt: args.now } }],
      },
    });
    return r.count;
  },

  /**
   * Count a user's requests created at/after `since` — the per-user rate-limit
   * read. Runs inside the request transaction (it gates the subsequent insert),
   * so it takes `tx`.
   */
  async countRecentForUser(
    userId: string,
    since: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.emailChangeRequest.count({
      where: { userId, createdAt: { gte: since } },
    });
  },

  /** Test-only direct read by token (asserts single-use deletion). */
  async findByTokenUnsafe(token: string): Promise<EmailChangeRequest | null> {
    return db.emailChangeRequest.findUnique({ where: { token } });
  },
};
