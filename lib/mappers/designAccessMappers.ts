import type { WorkItem } from '@/generated/prisma/client';
import type { DesignAssetWithAttachment, DesignEvidenceWithAssets } from './designEvidenceMappers';
import type { ApprovedDesignAssetDto, ApprovedDesignDto } from '@/lib/dto/designAccess';

// Prisma → DTO conversion for the approved-design read (Story MOTIR-5553 ·
// Subtask MOTIR-5557). Called by designAccessService just before returning
// (CLAUDE.md — services never return raw Prisma models).

/** `design/work-items/detail.mock.html` → `detail.mock.html`. */
function fileNameOf(sourcePath: string): string {
  return sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
}

/**
 * ONE asset, as an agent reads it.
 *
 * ⚠️ NO `url`. `DesignAssetDTO` carries the authenticated
 * `/api/attachments/<id>/content` path, which is a browser's door — it needs a
 * session cookie and it 302s. An agent gets a SHORT-LIVED link from
 * `designAccessService.downloadLinks` when it asks for one, so a design payload
 * never carries a URL that has already started expiring (AMENDMENT 5 Q6).
 */
export function toApprovedDesignAssetDto(row: DesignAssetWithAttachment): ApprovedDesignAssetDto {
  return {
    kind: row.kind,
    sourcePath: row.sourcePath,
    fileName: fileNameOf(row.sourcePath),
    contentType: row.attachment?.mimeType ?? null,
    byteSize: row.attachment?.sizeBytes ?? null,
    // The attachment is what the orphan-GC reclaims; its absence IS the
    // unavailable state, and it is a normal end state rather than an error.
    state: row.attachment ? 'available' : 'unavailable',
  };
}

export function toApprovedDesignDto(
  card: Pick<WorkItem, 'identifier' | 'title'>,
  row: DesignEvidenceWithAssets,
): ApprovedDesignDto {
  return {
    designCardKey: card.identifier,
    designCardTitle: card.title,
    evidenceId: row.id,
    publishedAt: row.createdAt.toISOString(),
    commitSha: row.commitSha,
    // Render order is the stored `position`; the repository orders on it, and
    // this sorts again so a caller that assembled rows by hand cannot render
    // them out of order — the same belt-and-braces `toDesignEvidenceDto` uses.
    assets: [...row.assets].sort((a, b) => a.position - b.position).map(toApprovedDesignAssetDto),
  };
}
