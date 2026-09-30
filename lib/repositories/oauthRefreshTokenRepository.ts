import type { Prisma } from '@/generated/prisma/client';

// Data access for `oauth_refresh_token` (Story MOTIR-6973 · Subtask MOTIR-6984)
// — a table `@better-auth/oauth-provider` writes. The provider issues, rotates
// and revokes these rows through its own adapter; Motir only sweeps the ones
// nothing can use any more. Single-op, no logic (CLAUDE.md 4-layer split).

export const oauthRefreshTokenRepository = {
  /**
   * Delete up to `limit` refresh tokens past their expiry, or carrying NO
   * connection (the MCP gate would refuse every access token they mint). Their
   * access tokens go with them (`refresh_id` cascades).
   *
   * ⚠️ A REVOKED-BUT-UNEXPIRED row is KEPT on purpose: the provider reads it to
   * detect a replayed refresh token and invalidate that token's whole family. Its
   * expiry sweeps it in time. One bounded statement, idempotent.
   */
  async deleteUnusable(before: Date, limit: number, tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`
      DELETE FROM "oauth_refresh_token"
       WHERE "id" IN (
         SELECT "id" FROM "oauth_refresh_token"
          WHERE "expires_at" < ${before} OR "reference_id" IS NULL
          LIMIT ${limit}
       )`;
  },
};
