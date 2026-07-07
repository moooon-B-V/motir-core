import type { ImportSourceIdentity } from '@prisma/client';
import type {
  ImportSourceIdentityDTO,
  ImportSourceIdentityMetadata,
} from '@/lib/dto/importSourceIdentity';

// Prisma → DTO conversion for the import-source identity store (Story 7.16 ·
// MOTIR-1653). The token-free mapper is the enforcement point for "no secret
// crosses the API boundary": it structurally cannot leak
// `accessTokenEncrypted` / `refreshTokenEncrypted` (never referenced).

/**
 * Read the `metadata` Json column back into the typed shape. Prisma types a
 * nullable Json as `JsonValue`; a stored object round-trips to our optional-field
 * interface, and DB-null / a non-object value both normalise to null.
 */
export function toImportSourceIdentityMetadata(
  value: ImportSourceIdentity['metadata'],
): ImportSourceIdentityMetadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as ImportSourceIdentityMetadata;
}

export function toImportSourceIdentityDTO(row: ImportSourceIdentity): ImportSourceIdentityDTO {
  return {
    id: row.id,
    source: row.source,
    metadata: toImportSourceIdentityMetadata(row.metadata),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
