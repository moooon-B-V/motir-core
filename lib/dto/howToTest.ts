// Wire DTOs for the HOW TO TEST read (Story MOTIR-4906 · Subtask MOTIR-5333).
//
// HOW TO TEST is per RUN, on the RUN TARGET (`docs/decisions/approval-gates.md`
// §9's 2026-09-13 amendment). The read answers for ONE item: its current run's
// record — its rich-text body — and, per repository section, that
// repository's pull request, preview and checks. Every path is either filled or
// carries WHY it is unavailable, so a reviewer can tell "there is no preview"
// from "nobody wrote one". The PINNED shape is the design's Fields-read table
// (MOTIR-5327).
//
// ⚠️ NO URL TO THE DIFF. The Development row's own `LinkedPullRequestDto.url` is
// the diff link-out, and the block draws none.

import type { DeploymentState } from '@/lib/git/types';

/**
 * A stored deployment state, or `unknown` for a value no member names (raw kept).
 * DERIVED from the seam's union, so a member added there (as GitLab's `canceled`
 * was) reaches the read and the panel through the compiler, not by memory.
 */
export type HowToTestDeploymentState = DeploymentState | 'unknown';

/** A check conclusion as the block renders it; `unknown` keeps the raw value. */
export type HowToTestCheckConclusion = 'success' | 'failure' | 'pending' | 'neutral' | 'unknown';

export interface HowToTestCheckDto {
  name: string;
  conclusion: HowToTestCheckConclusion;
  /** The stored value when `conclusion` is `unknown`; null otherwise. */
  rawConclusion: string | null;
}

export type HowToTestPreviewDto =
  | {
      status: 'available';
      /** The deployment's URL joined with the record's `previewPath`, when both exist. */
      url: string;
      environment: string;
      state: 'success';
      /** The commit the deployment was made from. */
      deployedSha: string;
    }
  | {
      status: 'deployment_not_ready';
      state: HowToTestDeploymentState;
      /** The stored value when `state` is `unknown`; null otherwise. */
      rawState: string | null;
      environment: string;
    }
  | { status: 'no_deployment_reported' };

export type HowToTestCiDto =
  | { status: 'available'; checks: HowToTestCheckDto[] }
  | { status: 'no_checks_reported' };

/** The pull request a repository section is bound to. */
export interface HowToTestPullRequestRefDto {
  id: string;
  headRef: string;
  /** The PR's latest recorded check-row sha (the `prCiState` head), or null before any check. */
  headSha: string | null;
  state: 'open' | 'closed';
  merged: boolean;
}

/** One repository's section of the run's block. */
export interface HowToTestRepoDto {
  repoId: string;
  /** `owner/name`, for the section's sub-heading. */
  repoName: string;
  /** The commit the run wrote this section for. */
  commitSha: string;
  pullRequest: HowToTestPullRequestRefDto | null;
  /** True when a head is known and the section was written for a different commit. */
  stale: boolean;
  /**
   * `git fetch origin <headRef> && git checkout <headRef>`, the ref shell-quoted and
   * composed from the pull request — never the agent's — or null when no pull
   * request is bound. The block renders it as a copyable code block.
   */
  fetchCommand: string | null;
  preview: HowToTestPreviewDto;
  ci: HowToTestCiDto;
}

/** A dispatch run, as the block names it. */
export interface HowToTestRunDto {
  runId: string;
  label: string;
}

/**
 * WHO wrote a record (Story MOTIR-5450 · Subtask MOTIR-5454).
 *
 * `approval-gates.md` §9's 2026-09-17 amendment, point 1: TWO AUTHOR KINDS, ONE
 * RECORD, ONE WRITER. A record written by a dispatch run is a `run` author; one
 * written by a person from the item page is a `person` author. They are the same
 * row in the same table, written by the same `testInstructionsService.publish`,
 * and the block renders them identically apart from this line.
 *
 * `userId` is NULL when the publisher's account was deleted — `published_by_id`
 * is `SetNull`, like every audit stamp on the row — and the label is then the
 * product's standing string for an attribution whose referent is gone. It is
 * never blank: a missing author reads as a removed member, not as nobody.
 */
export type HowToTestAuthorDto =
  | { kind: 'run'; runId: string; label: string }
  | { kind: 'person'; userId: string | null; label: string };

/** The current record — what is ONE for the run target. */
export interface HowToTestRecordDto {
  id: string;
  /**
   * ⚠️ SUPERSEDED BY {@link HowToTestRecordDto.author}, and kept only until the
   * block reads it. `run` can name a dispatch run and nothing else, so a
   * person's record reads as `null` here — indistinguishable from an agent
   * record whose run was pruned. `HowToTestBlock` still reads it today; the
   * DOORS card (MOTIR-5455) moves the block onto `author` and DELETES this
   * field. Do not add a new reader.
   */
  run: HowToTestRunDto | null;
  /** WHO wrote it — a run or a person. Always present. */
  author: HowToTestAuthorDto;
  createdAt: string;
  /** The rich-text How to test, as its author wrote it. */
  bodyMd: string;
  previewPath: string | null;
}

/** An earlier record, for the "Earlier versions" disclosure. */
export interface HowToTestHistoryEntryDto {
  recordId: string;
  /** ⚠️ Superseded by {@link HowToTestHistoryEntryDto.author} — see the record's note. */
  run: HowToTestRunDto | null;
  /** WHO wrote it — a run or a person. Always present. */
  author: HowToTestAuthorDto;
  createdAt: string;
}

export interface HowToTestDto {
  /**
   * `record` — this item is a run target with a current record.
   * `record_missing` — no run has written one here (and no ancestor carries one).
   * `tested_via_ancestor` — this item has none, and its nearest ancestor that
   * does is `runTarget` (a child of a container run).
   */
  state: 'record' | 'record_missing' | 'tested_via_ancestor';
  /** The ancestor holding the record, for `tested_via_ancestor`; null otherwise. */
  runTarget: { key: string } | null;
  /** The latest run that targeted or carried this item, for `record_missing`. */
  owedBy: HowToTestRunDto | null;
  record: HowToTestRecordDto | null;
  /** One per record section, in the record's order; empty unless `state` is `record`. */
  repos: HowToTestRepoDto[];
  /** Earlier runs' records, newest first (the current one excluded). */
  history: HowToTestHistoryEntryDto[];
}
