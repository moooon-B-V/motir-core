import type { ApiTokenWithScope } from '@/lib/repositories/apiTokenRepository';
import type { ApiTokenDto } from '@/lib/dto/apiTokens';
import { expandStoredGrant } from '@/lib/tokens/grant';

// Prisma → DTO conversion for the api-token surface (Story 7.8 · Subtask
// 7.8.1, + bug 7.21 scope, + MOTIR-2572 grants). The mapper is where the secret is
// FENCED OFF: it reads `tokenHash` off the row but never copies it into the
// DTO, and dates become ISO strings (the API-boundary convention). It does not
// copy `revokedAt` either (MOTIR-3546): revocation DELETES the row, so a listed
// token is by construction a live one and there is no revoked state to render. It also
// flattens the bound `workspace` + its `organization` into the display labels
// the account-level list renders, and surfaces the token's granted `scopes`
// (MOTIR-2572) for the list's grant display. The service maps just before
// returning.
//
// ⚠️ THE GRANT IS EXPANDED HERE, NOT COPIED. `row.scopes` is the mixed-vocabulary
// column (see its schema doc-comment): a row minted before MOTIR-2572 holds
// legacy `TokenScope` strings and nothing rewrites them. Every read goes through
// `expandStoredGrant`, so the DTO carries permission keys and a consumer can
// never obtain a legacy string through it.

export function toApiTokenDto(row: ApiTokenWithScope): ApiTokenDto {
  return {
    id: row.id,
    label: row.label,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    project: row.project ? { id: row.project.id, name: row.project.name } : null,
    workspace: { id: row.workspace.id, name: row.workspace.name },
    organization: { id: row.workspace.organization.id, name: row.workspace.organization.name },
    permissions: expandStoredGrant(row.scopes).grant,
  };
}
