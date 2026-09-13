// Wire DTOs for the HOW TO TEST read (Story MOTIR-4906 · Subtask MOTIR-5333).
//
// The PINNED shape is the design's Fields-read table
// (`design/github/design-notes.md` §20.3): one entry per linked pull request,
// keyed by `GithubPullRequest.id` — the same id `LinkedPullRequestDto.id` carries
// to `PullRequestRow`, so a Development row looks up its own block. Every path is
// either filled or carries WHY it is unavailable, so a reviewer can tell "there is
// no preview" from "nobody wrote one".
//
// ⚠️ NO URL TO THE DIFF. The row's own `LinkedPullRequestDto.url` is the diff
// link-out, and the block draws none.

import type { SetupCommandDTO } from '@/lib/dto/testInstructions';
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

export type HowToTestLocalDto =
  | {
      status: 'available';
      /** `git fetch origin <headRef> && git checkout <headRef>`, the ref shell-quoted. */
      fetchCommand: string;
      setupCommands: SetupCommandDTO[];
      preconditionMd: string | null;
    }
  | { status: 'record_missing' };

export type HowToTestCiDto =
  | { status: 'available'; checks: HowToTestCheckDto[] }
  | { status: 'no_checks_reported' };

export interface HowToTestRecordDto {
  commitSha: string;
  /** True when a head is known and the record was written for a different commit. */
  stale: boolean;
  clickPathNotApplicable: boolean;
  clickPathNotApplicableReason: string | null;
}

/** One linked pull request's block. */
export interface HowToTestPullRequestDto {
  pullRequestId: string;
  repoId: string;
  headRef: string;
  /** The PR's latest recorded check-row sha (the `prCiState` head), or null before any check. */
  headSha: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  /** The record's click-path; empty when there is no record or it is not applicable. */
  clickPathSteps: string[];
  local: HowToTestLocalDto;
  preview: HowToTestPreviewDto;
  ci: HowToTestCiDto;
  record: HowToTestRecordDto | null;
}

/** The dispatch run that owed the instructions — the latest run that claimed the card. */
export interface HowToTestOwedByDto {
  runId: string;
  label: string;
}

export interface HowToTestDto {
  /** Empty when the item has no linked pull request. */
  byPullRequestId: Record<string, HowToTestPullRequestDto>;
  owedBy: HowToTestOwedByDto | null;
}
