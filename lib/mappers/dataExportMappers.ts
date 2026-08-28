import type { DataExportRequest } from '@/generated/prisma/client';
import type { DataExportRequestDTO } from '@/lib/dto/dataExport';

// Prisma → DTO conversion for the personal-data export request (Story 8.4 ·
// Subtask MOTIR-1136, over MOTIR-3701's row).
//
// The projection is the point rather than a formality. `blobPathname` is the
// private object's storage key — handing it to a page would put the one string
// the download route exists to keep server-side into a rendered payload — and
// `failureReason` is written for the operator answering `privacy@motir.co`, not
// for the reader, whose failed state shows the copy DECISION 2 fixes. Neither
// crosses this boundary.

/** One export request → the four fields the pane's export card renders. */
export function toDataExportRequestDTO(request: DataExportRequest): DataExportRequestDTO {
  return {
    id: request.id,
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
    builtAt: request.builtAt?.toISOString() ?? null,
    expiresAt: request.expiresAt?.toISOString() ?? null,
  };
}
