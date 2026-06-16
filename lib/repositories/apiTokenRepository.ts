import { Prisma, type ApiToken } from '@prisma/client';

/** An `api_token` row with its owning user eager-loaded — the verify lookup's
 * return shape, so the bearer gate resolves token → user in one round-trip. */
export type ApiTokenWithUser = Prisma.ApiTokenGetPayload<{ include: { user: true } }>;

/** An `api_token` row with its bound workspace + that workspace's organization
 * eager-loaded (bug 7.21) — the list/create return shape, so the DTO can label
 * each token with the org → workspace it belongs to without a second query. */
export type ApiTokenWithScope = Prisma.ApiTokenGetPayload<{
  include: { workspace: { include: { organization: true } } };
}>;

/** The include the list/create reads share to populate {@link ApiTokenWithScope}. */
const SCOPE_INCLUDE = {
  workspace: { include: { organization: true } },
} satisfies Prisma.ApiTokenInclude;

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
  /** The workspace this token is bound to (bug 7.21) — its active workspace at
   * mint time. The verify gate resolves the request workspace from it. */
  workspaceId: string;
  label: string;
  tokenHash: string;
  tokenPrefix: string;
  expiresAt: Date | null;
  /** The token's granted capability scopes (Story 7.7 · Subtask 7.7.16) — the
   * service resolves these (the caller's choice, or the default-all-minus-delete
   * set) and validates them before they reach here. */
  scopes: string[];
}

export const apiTokenRepository = {
  /** A user's tokens across ALL their workspaces, newest first — the
   * account-level settings list (bug 7.21: each row carries its bound workspace
   * + org so the list labels it). Runs under `withUserContext`, so RLS already
   * narrows to the owner. */
  async findByUser(userId: string, tx: Prisma.TransactionClient): Promise<ApiTokenWithScope[]> {
    return tx.apiToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: SCOPE_INCLUDE,
    });
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
   * (cross-user id reads as null → the service's 404-not-403). Includes the
   * bound workspace + org so the revoke response maps the scoped DTO. */
  async findByIdForUser(
    tokenId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ApiTokenWithScope | null> {
    return tx.apiToken.findFirst({ where: { id: tokenId, userId }, include: SCOPE_INCLUDE });
  },

  /** Persist a freshly-minted token's hash row, returning it with its bound
   * workspace + org so the service maps the scoped DTO. Required `tx`. */
  async create(
    input: CreateApiTokenInput,
    tx: Prisma.TransactionClient,
  ): Promise<ApiTokenWithScope> {
    return tx.apiToken.create({ data: input, include: SCOPE_INCLUDE });
  },

  /** Soft-revoke: stamp `revokedAt`, leaving the row for the audit trail.
   * Returns the row with its bound workspace + org so the service maps the
   * scoped DTO. Required `tx`. */
  async revoke(
    tokenId: string,
    revokedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<ApiTokenWithScope> {
    return tx.apiToken.update({
      where: { id: tokenId },
      data: { revokedAt },
      include: SCOPE_INCLUDE,
    });
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
