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
   * Re-key a user's CREDENTIAL account to a new email (Subtask 8.8.22). At
   * sign-up the credential row's `accountId` is set to the user's email; the
   * `@@unique([providerId, accountId])` constraint then means that if a verified
   * email change leaves `accountId` at the OLD address, a future sign-up reusing
   * the freed address would collide on it. So the confirm flow updates this in
   * the same transaction as the `User.email` swap. OAuth-only users have no
   * credential row → 0 rows updated (a no-op). Returns the rows changed.
   */
  async updateCredentialAccountId(
    userId: string,
    accountId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.account.updateMany({
      where: { userId, providerId: 'credential' },
      data: { accountId },
    });
    return r.count;
  },
};
