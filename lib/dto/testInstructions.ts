// Wire DTOs for the HOW TO TEST record (Story MOTIR-4906 · Subtask MOTIR-5328).
// The service maps rows to these via lib/mappers/testInstructionsMappers.ts just
// before returning. Dates are ISO strings, matching the other evidence DTOs.
//
// The record is per RUN on the run target (`docs/decisions/approval-gates.md` §9's
// 2026-09-13 amendment): one rich-text body for the run, and one section per
// repository the run touched (the commit it was written for).

import type { HowToTestAuthorDto } from '@/lib/dto/howToTest';

/** One repository's section of a run's HOW TO TEST. */
export interface TestInstructionsRepoDTO {
  /** The `GithubRepo` id the section is keyed on. */
  repoId: string;
  /** The head commit this repository's section was written for. */
  commitSha: string;
}

/** One stored version of a run target's HOW TO TEST — the output of one run. */
export interface TestInstructionsDTO {
  id: string;
  /** The run target. */
  workItemId: string;
  /** The run's HOW TO TEST as rich text (Markdown), exactly as the agent wrote it. */
  bodyMd: string;
  /** The path to open on the preview host, e.g. `/items/ACME-7`. */
  previewPath: string | null;
  /** One section per repository, in the order the publisher gave them. */
  repos: TestInstructionsRepoDTO[];
  /** The dispatch run that wrote it, when one did. */
  dispatchRunId: string | null;
  publishedById: string | null;
  isCurrent: boolean;
  createdAt: string;
}

/** What a publish answers: the stored record, and whether this call wrote it. */
export interface PublishTestInstructionsResultDTO {
  record: TestInstructionsDTO;
  /** False when an identical record for the same run already existed (a retry). */
  created: boolean;
}

/**
 * A run target's CURRENT record as the public read answers it (MOTIR-5358) — each
 * section carrying the repository's `owner/name`, so a CLI can render the section
 * belonging to the repository whose pull request body it is writing.
 */
export interface CurrentTestInstructionsDTO {
  workItemKey: string;
  record:
    | (Omit<TestInstructionsDTO, 'repos'> & {
        repos: Array<TestInstructionsRepoDTO & { repoName: string | null }>;
        /**
         * WHO wrote it — a run or a person (MOTIR-5454). The same mapping the
         * item page's block reads, from the same `lib/howToTest/author` helper,
         * so a CLI rendering this into a pull-request body and a reviewer
         * reading the card name the author identically.
         */
        author: HowToTestAuthorDto;
      })
    | null;
}

// ── The DRAFT a person's form opens on (Story MOTIR-5450 · Subtask MOTIR-5453) ──
//
// `approval-gates.md` §9's 2026-09-17 amendment, point 2: a person writes the
// INSTRUCTIONS and Motir derives the DELIVERY. So the draft is the two fields a
// person actually edits, and nothing else.
//
// ⚠️ IT CARRIES NO REPOSITORY DATA, AND THAT IS THE POINT (design-notes.md §24,
// decisions 8 and 8b). An earlier shape returned `sections[]` — each with a
// `source` and a nullable `commitSha` — plus `projectRepos[]`, to fill a picker
// and its commit inputs. The form has no such control: a repository enters a
// record by having its pull request LINKED, which the Development rows directly
// above the part already show. Re-adding either field here is how that control
// comes back.
//
// It is NOT a validation contract either: both fields are re-checked by
// `testInstructionsService.publish`, which is the one writer for both author
// kinds, so a draft that suggests nothing is still savable.

/** The filled-in form a person opens Add or Edit onto. */
export interface HowToTestDraftDTO {
  /** The current record's body, or `''` when there is none. */
  bodyMd: string;
  /** The current record's preview path, or `null` when there is none. */
  previewPath: string | null;
}
