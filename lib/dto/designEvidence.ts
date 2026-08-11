// Wire DTOs for the design-result surface (Story MOTIR-2664 · Subtask
// MOTIR-2666). The service maps Prisma rows to these via
// lib/mappers/designEvidenceMappers.ts just before returning (CLAUDE.md —
// services never return raw Prisma models). Dates are ISO strings, matching the
// work-items / attachments / acceptance DTO convention.

/** Which artifact a design asset is (mirrors the `design_asset_kind` enum). */
export type DesignAssetKindDTO = 'mock' | 'image' | 'note_file';

/**
 * ONE artifact of a design result. `url` is the AUTHENTICATED content path
 * (`/api/attachments/[id]/content`), which 302s to a short-lived presigned URL
 * on the object-store host — never a public URL, and cross-origin to the app by
 * construction (docs/decisions/design-result.md §5b).
 *
 * `url` / `mimeType` / `sizeBytes` are null once the orphan-GC has reclaimed a
 * superseded blob (history rows only — a current row always has its attachment).
 */
export interface DesignAssetDTO {
  id: string;
  kind: DesignAssetKindDTO;
  /** `/api/attachments/<id>/content`, or null once the blob is GC-reclaimed. */
  url: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** The repo path this came from, e.g. `design/work-items/detail.mock.html`. */
  sourcePath: string;
  position: number;
}

/**
 * The CURRENT design result for a work item, as the Design result panel renders
 * it.
 *
 * `noteMd` is the extracted `design-notes.md` SECTION text — not the whole
 * per-AREA file — capped at 64 KiB for rendering. When `noteTruncated` is true
 * the panel says so and points at the `note_file` asset, which always carries
 * the complete text (§1).
 */
export interface DesignEvidenceDTO {
  id: string;
  /** The work item whose design this is — the card that produced it. */
  workItemId: string;
  noteMd: string | null;
  noteTruncated: boolean;
  /** Every published artifact, in render order. */
  assets: DesignAssetDTO[];
  /** Provenance from the CI run that published it. */
  commitSha: string | null;
  ciRunUrl: string | null;
  /** The card key whose PR produced this result (e.g. "MOTIR-2669"). */
  producedByKey: string | null;
  createdAt: string;
}
