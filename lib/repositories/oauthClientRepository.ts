import type { OauthClient, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Data access for `oauth_client` (Story MOTIR-6973 · Subtask MOTIR-6983) —
// a table `@better-auth/oauth-provider` writes. Registration and every update go
// through the provider's adapter; the consent decision reads the client to name
// the connection it records, and the OAuth sweep (MOTIR-6984) prunes the ones
// nobody ever connected.
// No RLS (identity-scoped, see the MOTIR-6982 migration), so a plain read.

export const oauthClientRepository = {
  /** A client by the public `client_id` it presents. */
  async findByClientId(clientId: string): Promise<OauthClient | null> {
    return dbRead.oauthClient.findUnique({ where: { clientId } });
  },

  /**
   * Delete up to `limit` DYNAMICALLY REGISTERED clients created before `before`
   * that hold NO connection — the OAuth sweep (MOTIR-6984). Registration is open
   * to anyone, so without this the table grows with every client that registered
   * and never got a person's consent. `user_id IS NULL` is what "dynamically
   * registered" means here: unauthenticated registration leaves it null.
   *
   * ⚠️ A client WITH a connection is never deleted — only revoking its
   * connections makes it prunable. The `NOT EXISTS` reads `api_token`, whose RLS
   * shows a row only to its owner or the system, so the caller MUST run this under
   * `withSystemContext`; under any other context every connection would read as
   * absent and live clients would be deleted with their tokens.
   */
  async deleteUnconnectedBefore(
    before: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      DELETE FROM "oauth_client"
       WHERE "id" IN (
         SELECT c."id" FROM "oauth_client" c
          WHERE c."created_at" < ${before}
            AND c."user_id" IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM "api_token" t WHERE t."oauth_client_id" = c."client_id"
            )
          LIMIT ${limit}
       )`;
  },
};
