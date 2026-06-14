import { Prisma, type ApiToken } from '@prisma/client';

/** An `api_token` row with its owning user eager-loaded — the verify lookup's
 * return shape, so the bearer gate resolves token → user in one round-trip. */
export type ApiTokenWithUser = Prisma.ApiTokenGetPayload<{ include: { user: true } }>;

// API-token repository — single Prisma operations on the `api_token` table
// (Story 7.8 · Subtask 7.8.1). The persistence leaf `apiTokensService` reads
// (the settings list, the verify lookup) and writes (mint, revoke, the
// throttled last-used touch). The SERVICE owns transactions, token
// generation/hashing, validation, the throttle decision, and DTO mapping;
// this leaf holds none of that.
//
// Layer rules (CLAUDE.md): writes (`create`, `revoke`, `touchLastUsed`)
// REQUIRE `tx`; the reads here all run INSIDE a context transaction (the
// settings reads under `withUserContext`, the verify lookup under
// `withSystemContext` — see the service), so they take `tx` too. No business
// logic, no transactions, no DTO mapping.

export interface CreateApiTokenInput {
  userId: string;
  label: string;
  tokenHash: string;
  tokenPrefix: string;
  expiresAt: Date | null;
}

export const apiTokenRepository = {
  /** A user's tokens, newest first — the settings-list read (under
   * `withUserContext`, so RLS already narrows to the owner). */
  async findByUser(userId: string, tx: Prisma.TransactionClient): Promise<ApiToken[]> {
    return tx.apiToken.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  },

  /** The verify lookup — an equality probe on the unique `token_hash` index
   * (constant work regardless of token validity). Runs under
   * `withSystemContext` (pre-auth, no user context yet). */
  async findByTokenHash(
    tokenHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<ApiTokenWithUser | null> {
    return tx.apiToken.findUnique({ where: { tokenHash }, include: { user: true } });
  },

  /** One token by id, scoped to its owner — the revoke ownership probe
   * (cross-user id reads as null → the service's 404-not-403). */
  async findByIdForUser(
    tokenId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ApiToken | null> {
    return tx.apiToken.findFirst({ where: { id: tokenId, userId } });
  },

  /** Persist a freshly-minted token's hash row. Required `tx`. */
  async create(input: CreateApiTokenInput, tx: Prisma.TransactionClient): Promise<ApiToken> {
    return tx.apiToken.create({ data: input });
  },

  /** Soft-revoke: stamp `revokedAt`, leaving the row for the audit trail.
   * Required `tx`. */
  async revoke(tokenId: string, revokedAt: Date, tx: Prisma.TransactionClient): Promise<ApiToken> {
    return tx.apiToken.update({ where: { id: tokenId }, data: { revokedAt } });
  },

  /** Stamp `lastUsedAt` — the throttled verify touch. Required `tx`. */
  async touchLastUsed(
    tokenId: string,
    lastUsedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<ApiToken> {
    return tx.apiToken.update({ where: { id: tokenId }, data: { lastUsedAt } });
  },
};
