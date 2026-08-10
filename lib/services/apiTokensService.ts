import type { User } from '@/generated/prisma/client';
import { withSystemContext, withUserContext } from '@/lib/workspaces/context';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationsService } from '@/lib/services/organizationsService';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { toApiTokenDto } from '@/lib/mappers/apiTokenMappers';
import { generateToken, hashToken, tokenPrefixOf } from '@/lib/apiTokens/token';
import {
  ApiTokenExpiredError,
  ApiTokenNotFoundError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
  InvalidApiTokenLabelError,
  InvalidTokenGrantError,
} from '@/lib/apiTokens/errors';
import { DEFAULT_TOKEN_GRANT, expandStoredGrant, isGrantable } from '@/lib/tokens/grant';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ApiTokenDto, CreateApiTokenResult, TokenScopeOrgDTO } from '@/lib/dto/apiTokens';

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
  /** The GRANT — the permission keys this token may exercise (MOTIR-2572).
   * Omit/undefined = `DEFAULT_TOKEN_GRANT` (every grantable permission except
   * the irreversible one); an explicit list narrows it. Every entry must be
   * GRANTABLE or create rejects with `InvalidTokenGrantError` (422). */
  permissions?: string[];
}

function normalizeLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidApiTokenLabelError();
  }
  return trimmed;
}

/**
 * Resolve the GRANT a `create` call persists: {@link DEFAULT_TOKEN_GRANT} when
 * the caller passes none, else the explicit list — validated so every entry is
 * GRANTABLE, rejecting anything else with {@link InvalidTokenGrantError} (422).
 * Returns a de-duplicated list.
 *
 * An EMPTY explicit list is allowed through to persistence and yields a token
 * that can do nothing. That is a legitimate thing to mint (and the surface
 * refuses it with its own copy before it gets here); refusing it in the service
 * would make "grant nothing" un-expressible through the API for no safety gain —
 * the failure direction is already the harmless one.
 */
function resolveGrant(requested: string[] | undefined): PermissionKey[] {
  if (requested === undefined) return [...DEFAULT_TOKEN_GRANT];
  const invalid = requested.filter((key) => !isGrantable(key));
  if (invalid.length > 0) throw new InvalidTokenGrantError(invalid);
  // Validated above, so every entry is a grantable PermissionKey.
  return [...new Set(requested as PermissionKey[])];
}

export const apiTokensService = {
  /**
   * Mint a token for `userId`. Generates the secret, persists ONLY its
   * sha-256 hash + display prefix in a transaction, and returns the plaintext
   * ONCE (never persisted, never logged) alongside the display-safe DTO. The
   * caller shows the plaintext once with a copy affordance; after that it is
   * irretrievable.
   */
  async create(
    userId: string,
    workspaceId: string,
    input: CreateApiTokenInput,
  ): Promise<CreateApiTokenResult> {
    const label = normalizeLabel(input.label);
    // Validate + default the grant BEFORE the membership round-trip, so a bad
    // permission list fails fast (422) without touching the DB — and, since the
    // whole create is one write, nothing partial is ever persisted.
    const permissions = resolveGrant(input.permissions);
    // The token BINDS to `workspaceId` (bug 7.21), so the user must be a member
    // of it — the create UI only offers the user's own workspaces, but the
    // server is the authority (a forged id throws NotAMemberError → 403).
    await workspacesService.assertMembership(userId, workspaceId);
    const token = generateToken();
    const row = await withUserContext(userId, (tx) =>
      apiTokenRepository.create(
        {
          userId,
          workspaceId,
          label,
          tokenHash: hashToken(token),
          tokenPrefix: tokenPrefixOf(token),
          expiresAt: input.expiresAt ?? null,
          // The column's name is historical; it stores the grant. See its
          // schema doc-comment and `docs/decisions/token-permissions.md` §5.
          scopes: permissions,
        },
        tx,
      ),
    );
    return { token, dto: toApiTokenDto(row) };
  },

  /** A user's tokens across all their workspaces, newest first — the
   * account-level settings list. Each DTO carries the workspace + org it is
   * bound to (bug 7.21) so the list labels its scope. Display-safe (never the
   * hash). */
  async listForUser(userId: string): Promise<ApiTokenDto[]> {
    const rows = await withUserContext(userId, (tx) => apiTokenRepository.findByUser(userId, tx));
    return rows.map(toApiTokenDto);
  },

  /**
   * The org → workspace tree the create modal scopes a token within (bug 7.21):
   * every organization the user belongs to, each with the workspaces of it they
   * are a member of (an org with zero accessible workspaces is omitted). The
   * modal pre-selects the active workspace; the user can pick any of these.
   * Composes the same reads the shell switcher uses — no new persistence.
   */
  async listScopeOptions(userId: string): Promise<TokenScopeOrgDTO[]> {
    const [orgs, workspaces] = await Promise.all([
      organizationsService.listUserOrganizations(userId),
      workspacesService.listUserWorkspaces(userId),
    ]);
    const workspacesByOrg = new Map<string, { id: string; name: string }[]>();
    for (const w of workspaces) {
      const list = workspacesByOrg.get(w.organizationId) ?? [];
      list.push({ id: w.id, name: w.name });
      workspacesByOrg.set(w.organizationId, list);
    }
    return orgs
      .map((org) => ({ id: org.id, name: org.name, workspaces: workspacesByOrg.get(org.id) ?? [] }))
      .filter((org) => org.workspaces.length > 0);
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
   * and returns the owning User PLUS the workspace the token is BOUND to
   * (bug 7.21) — the MCP bearer gate resolves the request workspace from this
   * `workspaceId`, NOT the owner's default workspace, so a token minted in
   * workspace A always acts on A — AND the token's resolved GRANT
   * (MOTIR-2572), so each dispatch seam can narrow the owner's role to the
   * operations the grant permits.
   *
   * ⚠️ The grant is the EXPANDED one. A row minted before MOTIR-2572 holds
   * legacy scope strings, and `expandStoredGrant` maps them forward here — once,
   * at the single seam every caller comes through — so no gate ever sees a
   * legacy string. An unrecognised stored value is DROPPED and logged rather
   * than throwing: a malformed row must degrade to LESS access, never to a
   * default grant nobody chose.
   *
   * Returns the raw Prisma User (not a DTO) deliberately: the only caller is
   * internal infrastructure (the 7.8.4 transport gate building the request
   * actor), the same internal-caller exception `usersService.findOrCreateOAuthUser`
   * documents — there is no public-API shape for "the authenticated principal".
   */
  async verify(plaintext: string): Promise<{
    user: User;
    workspaceId: string;
    grant: PermissionKey[];
    /** @deprecated SCAFFOLDING — the raw column, for the two gates that have
     * not moved yet. Removed by MOTIR-2576 (MCP) / MOTIR-2577 (`/api/v1`). */
    scopes: string[];
  }> {
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
      const { grant, unrecognised } = expandStoredGrant(row.scopes);
      if (unrecognised.length > 0) {
        console.warn(
          `[apiTokens] token ${row.id} carries ${unrecognised.length} unrecognised grant value(s); ignoring them: ${unrecognised.map((u) => JSON.stringify(u.value)).join(', ')}`,
        );
      }
      return { user: row.user, workspaceId: row.workspaceId, grant, scopes: row.scopes };
    });
  },
};
