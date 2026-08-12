import type { Attachment, DesignAsset, DesignEvidence } from '@/generated/prisma/client';
import type { DesignAssetDTO, DesignEvidenceDTO } from '@/lib/dto/designEvidence';

// Prisma → DTO conversion for the design-result surface (Story MOTIR-2664 ·
// Subtask MOTIR-2666). Called by designEvidenceService just before returning
// (CLAUDE.md — services never return raw Prisma models).

/** A design asset joined to its stored Attachment (null once GC-reclaimed). */
export type DesignAssetWithAttachment = DesignAsset & { attachment: Attachment | null };

/** An evidence row joined to its assets, each with its Attachment. */
export type DesignEvidenceWithAssets = DesignEvidence & { assets: DesignAssetWithAttachment[] };

/**
 * The AUTHENTICATED content path for a stored artifact. Never a public or
 * presigned URL: the route authorizes the viewer against the owning work item
 * and only then 302s to a short-lived signed URL on the object-store host
 * (docs/decisions/design-result.md §5b).
 */
export function designAssetContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

export function toDesignAssetDto(row: DesignAssetWithAttachment): DesignAssetDTO {
  return {
    id: row.id,
    kind: row.kind,
    url: row.attachment ? designAssetContentPath(row.attachment.id) : null,
    mimeType: row.attachment?.mimeType ?? null,
    sizeBytes: row.attachment?.sizeBytes ?? null,
    sourcePath: row.sourcePath,
    position: row.position,
  };
}

export function toDesignEvidenceDto(row: DesignEvidenceWithAssets): DesignEvidenceDTO {
  return {
    id: row.id,
    workItemId: row.workItemId,
    noteMd: row.noteMd,
    noteTruncated: row.noteTruncated,
    // Render order is the stored `position`; the repository orders on it, but
    // sort here too so a caller that assembled rows by hand cannot render them
    // out of order.
    assets: [...row.assets].sort((a, b) => a.position - b.position).map(toDesignAssetDto),
    commitSha: row.commitSha,
    ciRunUrl: row.ciRunUrl,
    producedByKey: row.producedByKey,
    createdAt: row.createdAt.toISOString(),
  };
}
