// Wire DTOs for the story-acceptance evidence surface (Story MOTIR-1627 ·
// Subtask MOTIR-1629). The service maps Prisma rows to these via
// lib/mappers/acceptanceEvidenceMappers.ts just before returning (CLAUDE.md —
// services never return raw Prisma models). Dates are ISO strings, matching the
// work-items / attachments DTO convention.

/** One chapter marker the player renders as a scrubbable jump. */
export interface AcceptanceEvidenceChapterDTO {
  /** The step label shown at the marker (e.g. "Open the item"). */
  label: string;
  /** Offset into the video, in seconds. */
  tSeconds: number;
}

export type AcceptanceEvidenceStatusDTO = 'pending' | 'approved' | 'changes_requested';

/**
 * The CURRENT acceptance evidence for a story, as the acceptance panel renders
 * it. `videoUrl` / `mimeType` / `sizeBytes` come from the joined video
 * Attachment and are null once the orphan-GC has reclaimed a superseded blob
 * (history rows only — the current row always has its attachment).
 */
export interface AcceptanceEvidenceDTO {
  id: string;
  /** The story this evidence accepts. */
  workItemId: string;
  status: AcceptanceEvidenceStatusDTO;
  /** The authenticated content path for the recorded video (`/api/attachments/[id]/content`). */
  videoUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** The authenticated content path for the Playwright trace (dev diagnostic), when captured. */
  traceUrl: string | null;
  chapters: AcceptanceEvidenceChapterDTO[];
  /** Provenance from the CI run that produced the video. */
  commitSha: string | null;
  ciRunUrl: string | null;
  /** The E2E subtask key that produced this receipt (e.g. "MOTIR-1638"). */
  producedByKey: string | null;
  approvedById: string | null;
  /** ISO-8601, or null while pending / changes-requested. */
  approvedAt: string | null;
  createdAt: string;
}
