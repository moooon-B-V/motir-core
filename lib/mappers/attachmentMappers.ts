import type { Attachment, User } from '@prisma/client';
import { isImageType, isPdfType } from '@/lib/blob/allowlist';
import { attachmentContentPath } from '@/lib/blob/referencedUrls';
import type { AttachmentDTO, AttachmentUploaderDTO } from '@/lib/dto/attachments';

// Prisma → DTO converter for the attachment management surface (Story 5.2 ·
// Subtask 5.2.2). The service batches the uploader side read — ONE user
// lookup per page (no N+1) — and hands the bucket in; the mapper is pure
// shaping. The `isImage`/`isPdf` flags are computed HERE from the shared
// allowlist policy so the panel/lightbox (5.2.5/6) never re-derive the
// preview split client-side.

/**
 * Resolve the row's uploader from the batched user read. The `uploader`
 * relation is a required FK (the user's deletion cascades the rows), so every
 * persisted attachment's uploader row exists — a miss means the service
 * forgot to include the id in its batch read, which is a bug worth failing
 * loudly on, not a renderable state (the commentMappers precedent).
 */
function uploaderFor(row: Attachment, uploadersById: Map<string, User>): AttachmentUploaderDTO {
  const user = uploadersById.get(row.uploaderUserId);
  if (!user) {
    throw new Error(
      `Attachment ${row.id}: uploader ${row.uploaderUserId} missing from the batched read.`,
    );
  }
  return { id: user.id, name: user.name, image: user.image ?? null };
}

/**
 * Map one LINKED attachment row to its panel DTO. The management surface only
 * ever returns rows attached to an issue (the list read filters on
 * `workItemId`; attach links before mapping), so a null `workItemId` here is
 * a caller bug — fail loudly rather than ship a row no panel owns.
 */
export function toAttachmentDto(row: Attachment, uploadersById: Map<string, User>): AttachmentDTO {
  if (row.workItemId === null) {
    throw new Error(`Attachment ${row.id}: unlinked rows have no panel DTO form.`);
  }
  return {
    id: row.id,
    workItemId: row.workItemId,
    filename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    // acceptance_video rows are excluded from the panel read (MOTIR-1629), so a
    // row reaching this mapper is always editor|panel.
    source: row.source as 'editor' | 'panel',
    // The authenticated content path (private blob served via the auth'd route),
    // NOT a raw blob URL. The DTO field keeps its name; its value is the path.
    blobUrl: attachmentContentPath(row.id),
    isImage: isImageType(row.mimeType),
    isPdf: isPdfType(row.mimeType),
    uploader: uploaderFor(row, uploadersById),
    createdAt: row.createdAt.toISOString(),
  };
}
