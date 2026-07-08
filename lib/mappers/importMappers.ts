// Prisma `Import` → `ImportDto` (Story 7.16 · MOTIR-941). Pure mapping, no I/O —
// the service calls it just before returning (the 4-layer rule).

import type { Import } from '@prisma/client';
import type { ImportDto } from '@/lib/dto/import';
import type { ImportMapping } from '@/lib/import/engine/types';

export function toImportDto(row: Import): ImportDto {
  return {
    id: row.id,
    source: row.source,
    sourceRef: row.sourceRef,
    status: row.status,
    // `mapping` is stored as typed JSON (the user-confirmed config); it round-trips
    // as `ImportMapping`.
    mapping: (row.mapping as ImportMapping | null) ?? null,
    counts: {
      created: row.createdCount,
      updated: row.updatedCount,
      skipped: row.skippedCount,
      failed: row.failedCount,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
