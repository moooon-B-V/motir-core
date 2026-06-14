import type { ApiToken } from '@prisma/client';
import type { ApiTokenDto } from '@/lib/dto/apiTokens';

// Prisma → DTO conversion for the api-token surface (Story 7.8 · Subtask
// 7.8.1). The mapper is where the secret is FENCED OFF: it reads `tokenHash`
// off the row but never copies it into the DTO, and dates become ISO strings
// (the API-boundary convention). The service maps just before returning.

export function toApiTokenDto(row: ApiToken): ApiTokenDto {
  return {
    id: row.id,
    label: row.label,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
