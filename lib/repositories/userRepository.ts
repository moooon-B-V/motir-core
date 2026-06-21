import { Prisma, type User } from '@prisma/client';
import { db } from '@/lib/db';

// User repository — single Prisma operations on the `user` table.
// Per CLAUDE.md: write methods require `tx: Prisma.TransactionClient`.
// Reads called outside transactions use the `db` singleton.

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const userRepository = {
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<User | null> {
    const client = tx ?? db;
    return client.user.findUnique({ where: { id } });
  },

  /**
   * Batch-resolve users by id — the one round-trip the board swimlane
   * projection (Subtask 3.3.4) uses to label assignee lanes (id → name) without
   * an N+1 per lane. Order is unspecified; callers index by `id`. An empty id
   * set short-circuits without a query. Optional `tx` for callers already
   * inside a transaction (watchersService.addWatcher resolves the added
   * target's display fields in the same snapshot the write rode — 5.4.4).
   */
  async findByIds(ids: string[], tx?: Prisma.TransactionClient): Promise<User[]> {
    if (ids.length === 0) return [];
    const client = tx ?? db;
    return client.user.findMany({ where: { id: { in: ids } } });
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

  /**
   * Resolve a user by email. Takes an optional `tx` so the change-email flow can
   * re-read uniqueness INSIDE its transaction (the snapshot that gates the swap);
   * pure read-only callers omit it and use the `db` singleton.
   */
  async findByEmail(email: string, tx?: Prisma.TransactionClient): Promise<User | null> {
    const client = tx ?? db;
    return client.user.findUnique({ where: { email: normalizeEmail(email) } });
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

  /**
   * Swap a user's email (the confirm half of the verified-email-change flow,
   * Subtask 8.8.22). The address has been verified by clicking the emailed link,
   * so `emailVerified` is set true alongside. Can throw `P2002` on the
   * `User.email` unique index if the address was claimed between request and
   * confirm — the service catches it and rethrows `EmailTakenError`.
   */
  async updateEmail(id: string, email: string, tx: Prisma.TransactionClient): Promise<User> {
    return tx.user.update({
      where: { id },
      data: { email: normalizeEmail(email), emailVerified: true },
    });
  },

  /**
   * Update a user's own personal details (Story 8.8 · Subtask 8.8.21) — the
   * write behind the Account › Profile pane. A single Prisma `update`; the
   * caller (`usersService.updateProfile`) owns validation, the transaction, and
   * the old-blob cleanup. Only the keys PRESENT in `data` are written, so the
   * caller updates `name` and `image` independently (and passes `image: null`
   * to remove an avatar). Required `tx` per CLAUDE.md (write method).
   */
  async updateProfile(
    tx: Prisma.TransactionClient,
    id: string,
    data: { name?: string; image?: string | null },
  ): Promise<User> {
    return tx.user.update({ where: { id }, data });
  },
};
