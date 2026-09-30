import type { OauthClient } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Data access for `oauth_client` (Story MOTIR-6973 · Subtask MOTIR-6983) —
// Motir's READ of a table `@better-auth/oauth-provider` writes. Registration and
// every update go through the provider's adapter; the consent decision reads the
// client to name the connection it records and to refuse one that is disabled.
// No RLS (identity-scoped, see the MOTIR-6982 migration), so a plain read.

export const oauthClientRepository = {
  /** A client by the public `client_id` it presents. */
  async findByClientId(clientId: string): Promise<OauthClient | null> {
    return dbRead.oauthClient.findUnique({ where: { clientId } });
  },
};
