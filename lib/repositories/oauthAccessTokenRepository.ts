import type { Prisma } from '@/generated/prisma/client';

// Data access for `oauth_access_token` (Story MOTIR-6973 · Subtasks MOTIR-6983 /
// MOTIR-6984). The provider issues, rotates and revokes these rows through its
// own adapter; Motir needs two things from them: the MCP gate's lookup, a
// bearer's hash to the CONNECTION (`api_token`) it carries, and the sweep's
// delete of rows nothing can use any more. Single-op, no logic (CLAUDE.md 4-layer
// split); the checks live in `oauthConnectionsService.resolveAccessToken`.

/** An access token with the connection it resolves to and that connection's
 * person — the gate's whole answer in one round-trip. */
export type OAuthAccessTokenWithConnection = Prisma.OauthAccessTokenGetPayload<{
  include: { connection: { include: { user: true } } };
}>;

export const oauthAccessTokenRepository = {
  /**
   * The gate's lookup — an equality probe on the unique `token` column, which
   * holds the provider's HASH of the bearer (`storeTokens: "hashed"`), so the
   * work is the same whether or not the token exists.
   *
   * `tx` REQUIRED: the caller runs it under `withSystemContext`, because the
   * connection it joins is an `api_token` row and that table's RLS admits only
   * its owner or the system — and before this lookup there is no owner yet.
   */
  async findByTokenHash(
    tokenHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<OAuthAccessTokenWithConnection | null> {
    return tx.oauthAccessToken.findUnique({
      where: { token: tokenHash },
      include: { connection: { include: { user: true } } },
    });
  },

  /**
   * Delete up to `limit` access tokens nothing can use any more — the OAuth sweep
   * (MOTIR-6984): past their expiry, or carrying NO connection. A token with no
   * `reference_id` was minted outside a Motir consent decision (or before
   * MOTIR-6983 bound them), and the MCP gate refuses it, so it is dead weight. A
   * revoked connection's tokens are deleted by the revoke itself (the reference
   * cascades); this catches whatever the cascade could not name. One bounded
   * statement, idempotent: a deleted row stops matching.
   */
  async deleteUnusable(before: Date, limit: number, tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`
      DELETE FROM "oauth_access_token"
       WHERE "id" IN (
         SELECT "id" FROM "oauth_access_token"
          WHERE "expires_at" < ${before} OR "reference_id" IS NULL
          LIMIT ${limit}
       )`;
  },
};
