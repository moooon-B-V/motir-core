import { Prisma, type Account, type User } from '@prisma/client';
import { db } from '@/lib/db';

// Account repository — single Prisma operations on the `account` table
// (credential password hashes + OAuth provider linkages).

export const accountRepository = {
  async findByProviderAndAccountId(
    providerId: string,
    providerAccountId: string,
  ): Promise<(Account & { user: User }) | null> {
    return db.account.findUnique({
      where: {
        providerId_accountId: {
          providerId,
          accountId: providerAccountId,
        },
      },
      include: { user: true },
    });
  },

  async create(
    data: {
      userId: string;
      providerId: string;
      providerAccountId: string;
      accessToken?: string | null;
      refreshToken?: string | null;
      accessTokenExpiresAt?: Date | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<Account> {
    return tx.account.create({
      data: {
        userId: data.userId,
        providerId: data.providerId,
        accountId: data.providerAccountId,
        accessToken: data.accessToken ?? null,
        refreshToken: data.refreshToken ?? null,
        accessTokenExpiresAt: data.accessTokenExpiresAt ?? null,
      },
    });
  },

  async updateTokens(
    id: string,
    tokens: {
      accessToken?: string | null;
      refreshToken?: string | null;
      accessTokenExpiresAt?: Date | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<Account> {
    return tx.account.update({
      where: { id },
      data: {
        accessToken: tokens.accessToken ?? null,
        refreshToken: tokens.refreshToken ?? null,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt ?? null,
      },
    });
  },

  /**
   * The user's credential (`providerId="credential"`) Account row, if any.
   * Read-only path (the `hasPassword` capability check) — no `tx`. A user has
   * at most one credential row (one per email/password identity).
   */
  async findCredentialByUserId(userId: string): Promise<Account | null> {
    return db.account.findFirst({
      where: { userId, providerId: 'credential' },
    });
  },

  /**
   * Locking read of the credential Account's id + password hash, for the
   * change-password flow's verify-then-update. Uses `SELECT ... FOR UPDATE`
   * so two concurrent password changes serialize on the row instead of one
   * clobbering the other (the lock-before-read-derived-update rule). Returns
   * null when the user has no credential row (OAuth-only). Column identifiers
   * are camelCase in Postgres (no per-field @map on the Account model), hence
   * the quoted `"userId"` / `"providerId"`.
   */
  async lockCredentialByUserId(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; password: string | null } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; password: string | null }>>`
      SELECT "id", "password"
      FROM "account"
      WHERE "userId" = ${userId} AND "providerId" = 'credential'
      LIMIT 1
      FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Set the argon2id hash on a credential Account row. Write — requires `tx`.
   */
  async updatePassword(
    id: string,
    passwordHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<Account> {
    return tx.account.update({
      where: { id },
      data: { password: passwordHash },
    });
  },
};
