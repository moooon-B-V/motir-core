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
 * ONE minted upload grant. A presigned PUT bound to EXACTLY this pathname and
 * this content type — a holder can write that one private object, as that one
 * type, and nothing else (`mintPrivateUploadToken`'s `signableHeaders` is what
 * makes the type part of the signature rather than a suggestion).
 */
export interface DesignUploadTargetDTO {
  /** Echoed back so the caller can pair a grant with the file it asked for. */
  sourcePath: string;
  kind: DesignAssetKindDTO;
  /** The private-store key to PUT to, and to report back at register. */
  pathname: string;
  token: string;
  contentType: string;
  /**
   * The cap this upload is bound by. Told to the caller up front (MOTIR-1911's
   * lesson) — otherwise the only way to learn it is to exceed it and read an
   * opaque store error.
   */
  maxBytes: number;
}

/** The mint-token response: one grant per file the caller declared. */
export interface DesignUploadTokensDTO {
  targets: DesignUploadTargetDTO[];
}

/**
 * The design version a DECIDED approval gate was about, plus whether its files
 * are still there (Subtask MOTIR-5033; ADR docs/decisions/approval-gates.md
 * §6c).
 *
 * ⚠️ IT IS READ BY THE GATE'S `subjectId`, NEVER BY "the card's current
 * design", and that is the whole of what the approved state is worth. A design
 * is a moving object — the revise loop republishes it — so a decided gate
 * rendered over whatever is current now says *somebody approved a design*,
 * which is a claim about nothing. Rendered over the pinned row it says
 * *somebody approved THESE bytes*, which is what an auditor came for.
 */
export interface DesignGateSubjectDTO {
  /**
   * The version that was decided, with its assets — or **null when the row is
   * gone**, which is a real and expected answer rather than an error: only an
   * APPROVAL pins its bytes (§6c), so a version that was sent back is
   * superseded and reclaimed on purpose.
   */
  evidence: DesignEvidenceDTO | null;
  /**
   * Whether this version's files are RETAINED — `design_evidence.pinned_at`,
   * read off the row rather than inferred from the gate's state.
   *
   * ⚠️ IT IS NOT `state === 'approved'`, and deriving it that way would make
   * the line an unconditional reassurance on the one surface built to be
   * checkable. The pin is written in the deciding transaction and can
   * legitimately be absent from an approved gate — `pinCurrentForWorkItem`
   * returns null when a republish took the current row while the decision
   * waited for its lock, and the decision still stands. So the honest answer
   * comes from the bytes.
   */
  filesKept: boolean;
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
  /**
   * When this result was WITHDRAWN, or null (MOTIR-3215). The panel's read never
   * carries a non-null value — a withdrawn row is not current, so
   * `getCurrentForWorkItem` returns null and the panel shows its empty state.
   * It is carried on the DTO because the WITHDRAWAL's own response is the
   * caller's receipt, and because the three histories only stay legible if the
   * stamp travels with the row: no row = never designed, `withdrawnAt` null =
   * superseded by a later publish, `withdrawnAt` set = taken back.
   */
  withdrawnAt: string | null;
  /** WHO took it back; null with `withdrawnAt` set means the SYSTEM did. */
  withdrawnById: string | null;
  /** WHY, in the withdrawer's own words. */
  withdrawnReason: string | null;
}
