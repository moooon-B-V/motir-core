// Wire DTOs for the APPROVED-DESIGN read (Story MOTIR-5553 · Subtask
// MOTIR-5557), implementing `docs/decisions/design-result.md` AMENDMENT 5
// Q2–Q6. `designAccessService` maps Prisma rows to these just before returning
// (CLAUDE.md — services never return raw Prisma models). Dates are ISO strings,
// matching the design-evidence / attachments / acceptance DTO convention.
//
// ⚠️ THESE ARE DELIBERATELY NOT `DesignEvidenceDTO`. That one is the PANEL's
// view of a card's own current result — `noteMd`, `noteTruncated`, the
// authenticated `/api/attachments/<id>/content` path a browser follows. This is
// what an AGENT is handed about a design it did not produce: the version the
// approval named (Q2), its files described well enough to decide what to
// fetch, and nothing that only a logged-in browser could use.

import type { DesignAssetKindDTO } from '@/lib/dto/designEvidence';

/**
 * Whether an asset's stored file can still be fetched.
 *
 * ⚠️ `unavailable` IS A NORMAL ANSWER, NOT AN ERROR (AMENDMENT 5 Q6). Only an
 * APPROVAL pins a version's bytes (`approval-gates.md` §6c), and
 * `approvalGatesService.decide` pins the row that is CURRENT at decision time
 * rather than the row the gate asked about — it reports the difference as
 * `filesKept: false`. So an approved version can legitimately have had its
 * attachments reclaimed by the orphan-GC, and the honest answer is *this is the
 * approved design and its files are gone*, never a broken link and never a
 * silent substitution of some other version.
 */
export type DesignAssetState = 'available' | 'unavailable';

/** ONE file of an approved design, described so a consumer can decide to fetch it. */
export interface ApprovedDesignAssetDto {
  kind: DesignAssetKindDTO;
  /** The repository path it came from, e.g. `design/work-items/detail.mock.html`.
   *  A delta mock's amended base is found by this (AMENDMENT 5 Q6). */
  sourcePath: string;
  /** The basename a consumer writes it as — `$MOTIR_DESIGN_DIR`'s file names. */
  fileName: string;
  contentType: string | null;
  byteSize: number | null;
  state: DesignAssetState;
}

/** ONE approved design — the version an approval named, with every asset. */
export interface ApprovedDesignDto {
  designCardKey: string;
  designCardTitle: string;
  /** The version (AMENDMENT 5 Q3): the `DesignEvidence` row id, whose content
   *  never changes after publish. */
  evidenceId: string;
  publishedAt: string;
  /** Provenance, and NULL is ordinary — a design published from a tree with no
   *  commit behind it (AMENDMENT 5 Q3). */
  commitSha: string | null;
  assets: ApprovedDesignAssetDto[];
}

/**
 * Why a design card has NO approved design (AMENDMENT 5 Q2) — five reasons, so
 * a consumer can say which of five things happened rather than reporting an
 * empty result that could be any of them.
 */
export type NoDesignReason =
  /** The blocker's `type` is not `design`. */
  | 'not_a_design_card'
  /** A `design` card at any status but `done` — `approved` included. */
  | 'not_done'
  /** The card was cancelled. */
  | 'cancelled'
  /** The row the Q2 ladder resolved was taken back (`withdrawnAt` set). */
  | 'withdrawn'
  /** The card has no `design_evidence` row at all. */
  | 'no_result';

/** One design card's verdict: an approved design, or the reason there is none. */
export type DesignVerdictDto =
  | {
      verdict: 'approved';
      designCardKey: string;
      designCardTitle: string;
      design: ApprovedDesignDto;
    }
  | {
      verdict: 'not_approved';
      designCardKey: string;
      designCardTitle: string;
      reason: NoDesignReason;
    };

/** A short-lived link to ONE asset's bytes (AMENDMENT 5 Q6). */
export interface DesignDownloadLinkDto {
  sourcePath: string;
  fileName: string;
  url: string;
  expiresAt: string;
}

/** A page of a project's approved designs, newest first. */
export interface ApprovedDesignPageDto {
  designs: ApprovedDesignDto[];
  nextCursor: string | null;
}
