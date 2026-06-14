import type { User } from '@prisma/client';
import { withSystemContext, withUserContext } from '@/lib/workspaces/context';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { toApiTokenDto } from '@/lib/mappers/apiTokenMappers';
import { generateToken, hashToken, tokenPrefixOf } from '@/lib/apiTokens/token';
import {
  ApiTokenExpiredError,
  ApiTokenNotFoundError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
  InvalidApiTokenLabelError,
} from '@/lib/apiTokens/errors';
import type { ApiTokenDto, CreateApiTokenResult } from '@/lib/dto/apiTokens';

// API-token service (Story 7.8 · Subtask 7.8.1) — the auth substrate every
// other 7.8 subtask rides. Owns transactions, token generation/hashing,
// validation, the last-used throttle, DTO mapping, and typed errors over the
// `apiTokenRepository` leaf (CLAUDE.md 4-layer split).
//
// Two scoping contexts, by design:
//   * OWNER (create / listForUser / revoke) run under `withUserContext`, which
//     binds the `app.user_id` GUC the `api_token` RLS policy reads — a user
//     only ever sees/mutates their OWN tokens. Cross-user ids read as null →
//     ApiTokenNotFoundError (the 404-not-403 contract, no existence leak).
//   * SYSTEM (verify) runs under `withSystemContext`: the MCP bearer gate
//     resolves a presented secret BEFORE any user context exists, so it cannot
//     bind `app.user_id`. The system context (a constant, never user input —
//     the value verified is the hash, bound as a query param) lets the
//     hash probe see the row regardless of owner (the job-ledger precedent).
//
// The plaintext secret lives in exactly ONE place ever: `create`'s return
// value. It is generated, hashed, and persisted-as-hash; the row, every DTO,
// and every log hold only the hash + the display prefix.

/** Max label length — a human-facing name ("claude-code"), not free text. */
const MAX_LABEL_LENGTH = 100;

/** Skip the `lastUsedAt` write when the token was touched within this window,
 * so a chatty agent session does not write-amplify on every MCP call. */
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export interface CreateApiTokenInput {
  /** User-facing name, e.g. "claude-code". Required, trimmed, ≤ 100 chars. */
  label: string;
  /** Absolute expiry, or null/undefined to never expire. The settings UI
   * derives this from its 30/90/365-day-or-never select. */
  expiresAt?: Date | null;
}

function normalizeLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidApiTokenLabelError();
  }
  return trimmed;
}

export const apiTokensService = {
  /**
   * Mint a token for `userId`. Generates the secret, persists ONLY its
   * sha-256 hash + display prefix in a transaction, and returns the plaintext
   * ONCE (never persisted, never logged) alongside the display-safe DTO. The
   * caller shows the plaintext once with a copy affordance; after that it is
   * irretrievable.
   */
  async create(userId: string, input: CreateApiTokenInput): Promise<CreateApiTokenResult> {
    const label = normalizeLabel(input.label);
    const token = generateToken();
    const row = await withUserContext(userId, (tx) =>
      apiTokenRepository.create(
        {
          userId,
          label,
          tokenHash: hashToken(token),
          tokenPrefix: tokenPrefixOf(token),
          expiresAt: input.expiresAt ?? null,
        },
        tx,
      ),
    );
    return { token, dto: toApiTokenDto(row) };
  },

  /** A user's tokens, newest first — the settings-list read. Display-safe
   * DTOs (never the hash). */
  async listForUser(userId: string): Promise<ApiTokenDto[]> {
    const rows = await withUserContext(userId, (tx) => apiTokenRepository.findByUser(userId, tx));
    return rows.map(toApiTokenDto);
  },

  /**
   * Soft-revoke one of the user's own tokens — stamps `revokedAt`, leaving the
   * row for the audit trail. Revoking a token id that is missing OR owned by
   * another user is an ApiTokenNotFoundError (404-not-403). Returns the updated
   * DTO so the caller flips the row to the muted "Revoked" state from the
   * response (the inline-edit-no-tree-refresh contract).
   */
  async revoke(userId: string, tokenId: string): Promise<ApiTokenDto> {
    const updated = await withUserContext(userId, async (tx) => {
      const existing = await apiTokenRepository.findByIdForUser(tokenId, userId, tx);
      if (!existing) throw new ApiTokenNotFoundError(tokenId);
      // Idempotent: re-revoking keeps the original timestamp.
      if (existing.revokedAt) return existing;
      return apiTokenRepository.revoke(tokenId, new Date(), tx);
    });
    return toApiTokenDto(updated);
  },

  /**
   * Resolve a presented plaintext secret to its owning user — the MCP bearer
   * gate's only auth job. Re-hashes the input and probes the unique hash index
   * (constant work regardless of validity), then rejects each failure mode
   * with a DISTINCT typed error: unknown/malformed → InvalidApiTokenError,
   * soft-revoked → ApiTokenRevokedError, past-expiry → ApiTokenExpiredError.
   * On success, touches `lastUsedAt` (throttled to once per 5-minute window)
   * and returns the owning User.
   *
   * Returns the raw Prisma User (not a DTO) deliberately: the only caller is
   * internal infrastructure (the 7.8.4 transport gate building the request
   * actor), the same internal-caller exception `usersService.findOrCreateOAuthUser`
   * documents — there is no public-API shape for "the authenticated principal".
   */
  async verify(plaintext: string): Promise<User> {
    const tokenHash = hashToken(plaintext);
    return withSystemContext(async (tx) => {
      const row = await apiTokenRepository.findByTokenHash(tokenHash, tx);
      if (!row) throw new InvalidApiTokenError();
      if (row.revokedAt) throw new ApiTokenRevokedError();
      const now = new Date();
      if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
        throw new ApiTokenExpiredError();
      }
      // Throttle the last-used touch: skip the write inside the window.
      const lastUsed = row.lastUsedAt?.getTime();
      if (lastUsed === undefined || now.getTime() - lastUsed >= LAST_USED_THROTTLE_MS) {
        await apiTokenRepository.touchLastUsed(row.id, now, tx);
      }
      return row.user;
    });
  },
};
