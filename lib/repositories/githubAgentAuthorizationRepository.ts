import { Prisma, type GithubAgentAuthorization } from '@/generated/prisma/client';

// The Motir Agent authorization repository — single Prisma operations on the
// `github_agent_authorization` table (Story MOTIR-683 · MOTIR-6519). The service
// (`githubAgentAuthService`) owns the OAuth orchestration, the token crypto, the
// refresh and its transaction; this leaf holds none of that.
//
// Every method takes `tx`: they all run inside the service's `withUserContext`
// transaction, so RLS narrows every read and write to the acting member.

export interface UpsertGithubAgentAuthorizationInput {
  userId: string;
  githubUserId: string;
  githubLogin: string;
  accessTokenEncrypted: string;
  accessTokenExpiresAt: Date | null;
  refreshTokenEncrypted: string | null;
  refreshTokenExpiresAt: Date | null;
}

export interface UpdateGithubAgentTokensInput {
  accessTokenEncrypted: string;
  accessTokenExpiresAt: Date | null;
  refreshTokenEncrypted: string | null;
  refreshTokenExpiresAt: Date | null;
}

export const githubAgentAuthorizationRepository = {
  /** The acting member's authorization, or null when they have not linked. */
  async findByUserId(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubAgentAuthorization | null> {
    return tx.githubAgentAuthorization.findUnique({ where: { userId } });
  },

  /**
   * The acting member's authorization, LOCKED for the rest of the transaction —
   * the read that guards a refresh. GitHub rotates the refresh token on every
   * use, so two concurrent refreshes with the same token leave the loser holding
   * a dead one; the row lock serialises them, and the second caller reads the
   * pair the first one persisted.
   */
  async findByUserIdForUpdate(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubAgentAuthorization | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "github_agent_authorization" WHERE "user_id" = ${userId} FOR UPDATE`;
    if (rows.length === 0) return null;
    return tx.githubAgentAuthorization.findUnique({ where: { userId } });
  },

  /** Create-or-replace the acting member's authorization (a re-link replaces it). */
  async upsertForUser(
    input: UpsertGithubAgentAuthorizationInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubAgentAuthorization> {
    const { userId, ...rest } = input;
    return tx.githubAgentAuthorization.upsert({
      where: { userId },
      create: { userId, ...rest },
      update: rest,
    });
  },

  /** Persist a refreshed token pair. */
  async updateTokens(
    userId: string,
    input: UpdateGithubAgentTokensInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubAgentAuthorization> {
    return tx.githubAgentAuthorization.update({ where: { userId }, data: input });
  },

  /** Mark the refresh token unusable (GitHub refused it) so the surface reads
   *  `expired` rather than retrying a dead token on every read. */
  async markRefreshExpired(userId: string, at: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.githubAgentAuthorization.update({
      where: { userId },
      data: { refreshTokenExpiresAt: at, accessTokenExpiresAt: at },
    });
  },

  /** Remove the acting member's authorization (unlink). Idempotent: 0 when none. */
  async deleteByUserId(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.githubAgentAuthorization.deleteMany({ where: { userId } });
    return r.count;
  },
};
