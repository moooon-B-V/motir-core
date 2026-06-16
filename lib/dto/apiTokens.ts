// DTOs for the api-token surface (Story 7.8 · Subtask 7.8.1) — the shape that
// crosses the API boundary to the Settings → Account → API tokens surface
// (7.8.3) and back. The `tokenHash` NEVER appears in a DTO; the plaintext
// secret appears in exactly one place ever — `CreateApiTokenResult.token`.

import type { TokenScope } from '@/lib/mcp/scopes';

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
  /** The workspace this token is BOUND to (bug 7.21) + its organization — the
   * account-level list labels each row with its `org → workspace` scope, and the
   * MCP gate resolves the request workspace from it. */
  workspace: { id: string; name: string };
  organization: { id: string; name: string };
  /** The granted capability scopes (Story 7.7 · Subtask 7.7.16) the list
   * displays — the create-modal picker persists them and the row summarises
   * them (`read` / `work_items:write` / `work_items:archive` /
   * `work_items:delete` / `sprints:write` / `integration`). */
  scopes: TokenScope[];
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
