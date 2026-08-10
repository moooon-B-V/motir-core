// DTOs for the api-token surface (Story 7.8 · Subtask 7.8.1) — the shape that
// crosses the API boundary to the Settings → Account → API tokens surface
// (7.8.3) and back. The `tokenHash` NEVER appears in a DTO; the plaintext
// secret appears in exactly one place ever — `CreateApiTokenResult.token`.

import type { PermissionKey } from '@/lib/permissions/catalog';

/** One token as the settings list renders it. Display-safe: the `tokenPrefix`
 * is a hint, never the secret, and there is no `tokenHash`. Dates are ISO
 * strings (the API-boundary convention). */
export interface ApiTokenDto {
  id: string;
  label: string;
  /** First chars of the secret, e.g. `motir_pat_Ab` — display-only. */
  tokenPrefix: string;
  createdAt: string;
  /** Null = never expires. */
  expiresAt: string | null;
  /** Null = never used since mint. */
  lastUsedAt: string | null;
  /** Non-null = soft-revoked (the muted "Revoked" row). */
  revokedAt: string | null;
  /** The PROJECT this token is bound to, or NULL (MOTIR-2606).
   *
   * NULL is the DEVICE-CREDENTIAL SHAPE — what `motir login` mints — not a
   * missing value. The list renders the two differently on purpose: a bound
   * token names its project, a device credential names its workspace and says
   * it reaches every project the holder's roles allow. Rendering them the same
   * reads as an inconsistency rather than two kinds of credential. */
  project: { id: string; name: string } | null;
  /** The workspace this token is BOUND to (bug 7.21) + its organization — the
   * account-level list labels each row with its `org → workspace` scope, and the
   * MCP gate resolves the request workspace from it. */
  workspace: { id: string; name: string };
  organization: { id: string; name: string };
  /**
   * The token's GRANT (MOTIR-2572) — the permission keys it confers, RESOLVED:
   * a row written before this story has had its legacy scope strings expanded
   * through `LEGACY_SCOPE_PERMISSIONS` by the time it reaches here.
   *
   * The DTO deliberately exposes the EXPANDED grant and never the raw
   * `api_token.scopes` column, so no consumer can see — or come to depend on —
   * a legacy string. The list row summarises these and the picker persists them.
   */
  permissions: PermissionKey[];
  /**
   * @deprecated SCAFFOLDING — the RAW `api_token.scopes` column, mixed
   * vocabulary and all. Removed by MOTIR-2579, which replaces `scopeMeta.tsx`
   * with the catalog-driven presenter and re-points the two read surfaces onto
   * {@link ApiTokenDto.permissions}.
   *
   * It exists only because those surfaces render through the six-entry scope
   * table, and replacing that table is 2579's job — behind the design card. Read
   * `permissions` for anything new; a consumer that reads this is reading a
   * legacy string.
   */
  scopes: string[];
}

/** One workspace a token can be scoped to (bug 7.21) — the create modal's
 * workspace option. */
export interface TokenScopeWorkspaceDTO {
  id: string;
  name: string;
}

/** One organization the user belongs to, with the workspaces of it they can
 * mint a token in — the create modal's org → workspace picker source (bug 7.21).
 * Orgs with zero accessible workspaces are omitted. */
export interface TokenScopeOrgDTO {
  id: string;
  name: string;
  workspaces: TokenScopeWorkspaceDTO[];
}

/** The create result. `token` is the FULL plaintext secret — returned ONCE,
 * never persisted, never logged; the caller shows it once with a copy
 * affordance and then it is irretrievable. `dto` is the same display-safe row
 * the list shows. */
export interface CreateApiTokenResult {
  token: string;
  dto: ApiTokenDto;
}
