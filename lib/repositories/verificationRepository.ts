import { Prisma, type Verification } from '@prisma/client';
import { db } from '@/lib/db';

// Verification repository — Better-Auth's catch-all token table
// (identifier + value + expiresAt). Used by both password-reset (via
// Better-Auth internals) and our own invite flow (`workspace-invite:`
// prefix on identifier).

export const verificationRepository = {
  async findByIdentifier(identifier: string): Promise<Verification | null> {
    return db.verification.findFirst({ where: { identifier } });
  },

  /**
   * Count rows whose identifier starts with `identifierPrefix`, whose
   * `value` contains every entry in `valueContainsAll`, and whose
   * createdAt is >= `since`. Used by the invites service's rate-limit
   * gate: prefix narrows to invite tokens (via the existing
   * `@@index([identifier])`), the value substrings constrain to a
   * specific (workspaceId, email) pair, and the time window bounds the
   * scan.
   */
  async countByIdentifierPrefixAndValueAndSince(args: {
    identifierPrefix: string;
    valueContainsAll: string[];
    since: Date;
  }): Promise<number> {
    return db.verification.count({
      where: {
        identifier: { startsWith: args.identifierPrefix },
        createdAt: { gte: args.since },
        AND: args.valueContainsAll.map((substr) => ({ value: { contains: substr } })),
      },
    });
  },

  async create(
    data: { identifier: string; value: string; expiresAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<Verification> {
    return tx.verification.create({ data });
  },

  /**
   * Returns the number of rows deleted. The invite-accept flow uses
   * this inside a $transaction so the deletion is atomic with the
   * membership insert.
   */
  async deleteByIdentifier(identifier: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.verification.deleteMany({ where: { identifier } });
    return result.count;
  },

  /**
   * Back-dates a row's `expiresAt` — only used by tests to simulate
   * "user clicked the link after expiry" without sleeping. Production
   * code never calls this.
   */
  async updateExpiresAt(
    identifier: string,
    expiresAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.verification.updateMany({
      where: { identifier },
      data: { expiresAt },
    });
    return result.count;
  },
};
