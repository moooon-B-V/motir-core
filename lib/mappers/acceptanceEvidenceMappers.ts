import type { AcceptanceEvidence, Attachment } from '@prisma/client';
import { attachmentContentPath } from '@/lib/blob/referencedUrls';
import type {
  AcceptanceEvidenceChapterDTO,
  AcceptanceEvidenceDTO,
} from '@/lib/dto/acceptanceEvidence';

/** An evidence row with its (optional) joined video Attachment. */
export type AcceptanceEvidenceWithAttachment = AcceptanceEvidence & {
  attachment: Attachment | null;
};

/**
 * Coerce the stored `chapters` JSON into the DTO shape. The column is written
 * only through the service (an array of `{ label, tSeconds }`), but JSON is
 * structurally untyped at the DB boundary, so we validate defensively — a
 * malformed / legacy value degrades to `[]` rather than throwing in a render
 * path.
 */
function toChapters(value: unknown): AcceptanceEvidenceChapterDTO[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { label?: unknown }).label === 'string' &&
      typeof (entry as { tSeconds?: unknown }).tSeconds === 'number'
    ) {
      const e = entry as { label: string; tSeconds: number };
      return [{ label: e.label, tSeconds: e.tSeconds }];
    }
    return [];
  });
}

/** Prisma row (+ joined attachment) → the wire DTO the acceptance panel reads. */
export function toAcceptanceEvidenceDto(
  row: AcceptanceEvidenceWithAttachment,
): AcceptanceEvidenceDTO {
  return {
    id: row.id,
    workItemId: row.workItemId,
    status: row.status,
    videoUrl: row.attachment ? attachmentContentPath(row.attachment.id) : null,
    mimeType: row.attachment?.mimeType ?? null,
    sizeBytes: row.attachment?.sizeBytes ?? null,
    traceUrl: row.traceUrl,
    chapters: toChapters(row.chapters),
    commitSha: row.commitSha,
    ciRunUrl: row.ciRunUrl,
    producedByKey: row.producedByKey,
    approvedById: row.approvedById,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
