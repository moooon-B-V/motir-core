import type { Prisma } from '@/generated/prisma/client';

// Data access for `oauth_access_token` (Story MOTIR-6973 · Subtask MOTIR-6983) —
// Motir's READ of a table `@better-auth/oauth-provider` writes. The provider
// issues, rotates and revokes these rows through its own adapter; the one thing
// Motir needs from them is the MCP gate's lookup, a bearer's hash to the
// CONNECTION (`api_token`) it carries. Single-op, no logic (CLAUDE.md 4-layer
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
};
