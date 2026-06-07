import { Prisma, type User } from '@prisma/client';
import { db } from '@/lib/db';

// User repository — single Prisma operations on the `user` table.
// Per CLAUDE.md: write methods require `tx: Prisma.TransactionClient`.
// Reads called outside transactions use the `db` singleton.

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const userRepository = {
  async findById(id: string): Promise<User | null> {
    return db.user.findUnique({ where: { id } });
  },

  /**
   * Batch-resolve users by id — the one round-trip the board swimlane
   * projection (Subtask 3.3.4) uses to label assignee lanes (id → name) without
   * an N+1 per lane. Order is unspecified; callers index by `id`. An empty id
   * set short-circuits without a query.
   */
  async findByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    return db.user.findMany({ where: { id: { in: ids } } });
  },

  /**
   * Acquire a row-level lock on the user inside the caller's transaction.
   * Used by ensureDefaultWorkspace to serialize the zero-membership
   * check-then-create: two concurrent first-requests both lock the same
   * user row, so the second blocks until the first commits its membership
   * and then re-reads a non-zero count (no duplicate default workspace).
   * Returns null when the user id doesn't exist. Read-inside-a-transaction
   * → requires `tx` per CLAUDE.md.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "user" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async findByEmail(email: string): Promise<User | null> {
    return db.user.findUnique({ where: { email: normalizeEmail(email) } });
  },

  async findByEmailWithCredentialAccount(email: string) {
    return db.user.findUnique({
      where: { email: normalizeEmail(email) },
      include: {
        accounts: {
          where: { providerId: 'credential' },
          take: 1,
        },
      },
    });
  },

  async createWithCredentialAccount(
    data: {
      email: string;
      name: string;
      passwordHash: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<User> {
    const email = normalizeEmail(data.email);
    return tx.user.create({
      data: {
        email,
        name: data.name,
        emailVerified: false,
        accounts: {
          create: {
            providerId: 'credential',
            accountId: email,
            password: data.passwordHash,
          },
        },
      },
    });
  },

  async createOAuthUser(
    data: {
      email: string;
      name: string;
      image?: string | null;
      providerId: string;
      providerAccountId: string;
      accessToken?: string | null;
      refreshToken?: string | null;
      accessTokenExpiresAt?: Date | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<User> {
    return tx.user.create({
      data: {
        email: normalizeEmail(data.email),
        name: data.name,
        image: data.image ?? null,
        emailVerified: true,
        accounts: {
          create: {
            providerId: data.providerId,
            accountId: data.providerAccountId,
            accessToken: data.accessToken ?? null,
            refreshToken: data.refreshToken ?? null,
            accessTokenExpiresAt: data.accessTokenExpiresAt ?? null,
          },
        },
      },
    });
  },

  async setEmailVerified(
    id: string,
    verified: boolean,
    tx: Prisma.TransactionClient,
  ): Promise<User> {
    return tx.user.update({
      where: { id },
      data: { emailVerified: verified },
    });
  },
};
