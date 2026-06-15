import type { ApiTokenWithScope } from '@/lib/repositories/apiTokenRepository';
import type { ApiTokenDto } from '@/lib/dto/apiTokens';

// Prisma → DTO conversion for the api-token surface (Story 7.8 · Subtask
// 7.8.1, + bug 7.21 scope). The mapper is where the secret is FENCED OFF: it
// reads `tokenHash` off the row but never copies it into the DTO, and dates
// become ISO strings (the API-boundary convention). It also flattens the bound
// `workspace` + its `organization` into the display labels the account-level
// list renders. The service maps just before returning.

export function toApiTokenDto(row: ApiTokenWithScope): ApiTokenDto {
  return {
    id: row.id,
    label: row.label,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    workspace: { id: row.workspace.id, name: row.workspace.name },
    organization: { id: row.workspace.organization.id, name: row.workspace.organization.name },
  };
}
