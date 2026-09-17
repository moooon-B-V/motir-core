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
// `approval-gates.md` §9's 2026-09-17 amendment, point 3: SUGGESTED, NEVER
// FORCED. The draft is what Motir already knows — the current record, or the
// linked pull requests' live heads — offered as starting values a person may
// change, remove or ignore. It is NOT a validation contract: every field here is
// re-validated by `testInstructionsService.publish`, which is the one writer for
// both author kinds, so a draft that suggests nothing is still savable and a
// draft a person empties is refused by `publish` rather than by this shape.

/** Where a suggested section's values came from — the form says so per row. */
export type HowToTestDraftSectionSource = 'record' | 'pull_request';

/** One suggested repository section of a person's How to test. */
export interface HowToTestDraftSectionDTO {
  /** The `GithubRepo` id the section is keyed on. */
  repoId: string;
  /**
   * `owner/name`. Falls back to the `repoId` when the repository is no longer
   * one of the project's — the same fallback the read uses
   * (`howToTestService.getForWorkItem`), so the two surfaces never disagree
   * about a repository that was unlinked after a record was written.
   */
  repoName: string;
  /**
   * The commit to offer. NULL when the bound pull request has no check row yet,
   * so no head has been reported — the form then asks the person for one,
   * because `publish` requires a commit on every section.
   */
  commitSha: string | null;
  source: HowToTestDraftSectionSource;
}

/** One repository a person may add a section for. */
export interface HowToTestDraftProjectRepoDTO {
  repoId: string;
  /** `owner/name`. */
  repoName: string;
}

/** The filled-in form a person opens Add or Edit onto. */
export interface HowToTestDraftDTO {
  /** The current record's body, or `''` when there is none. */
  bodyMd: string;
  /** The current record's preview path, or `null` when there is none. */
  previewPath: string | null;
  /**
   * With a current record: its sections, `source: 'record'`. Without one: one
   * section per repository that has a linked pull request — the item's own
   * first, then its descendants' — `source: 'pull_request'`. Empty when neither
   * exists, which is legal: an agent does not need a pull request either.
   */
  sections: HowToTestDraftSectionDTO[];
  /**
   * Every REALIZED repository of the project — the set `+ Add repository` offers
   * and the same set `resolveProjectRepoSections` validates a save against.
   */
  projectRepos: HowToTestDraftProjectRepoDTO[];
}
