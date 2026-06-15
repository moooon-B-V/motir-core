// DTOs for the public-project write/read entry points (Story 6.12 · Subtask
// 6.12.5). What crosses the HTTP boundary for the public "submit a request" +
// duplicate-detection surfaces — no Prisma row shape leaks. The submission
// itself returns the shared `TriageSubmissionResultDto` (it IS a triage
// submission, born through the 6.11.4 intake path); these are the dedupe shapes.

import type { WorkItemKindDto } from './workItems';

/**
 * One duplicate-detection candidate — an existing PUBLIC REQUEST that matches a
 * draft submission's title, surfaced so the submitter can **upvote this
 * instead** of creating a dupe (Canny's behaviour). Carries just what the
 * "upvote this instead" affordance renders: the identity + the current
 * status/vote-count demand signal. The full body lives behind the request's own
 * public detail (6.12.4 / 6.12.6).
 */
export interface PublicRequestMatchDto {
  id: string;
  /** A request is `bug` (bug report) or `task` (feature request). */
  kind: WorkItemKindDto;
  /** The allocated work-item identifier (e.g. "PROD-42"). */
  identifier: string;
  title: string;
  /** The request's workflow status key (e.g. "open", "in_progress"). */
  status: string;
  /** Current upvote count — the demand signal (zero until 6.12.6 lands votes). */
  voteCount: number;
}

/**
 * The duplicate-detection result for a draft title — the matching existing
 * public requests, ordered highest-demand first. An empty `candidates` array
 * means "no match — submit as new". The list is bounded (never load-all).
 */
export interface PublicDuplicateMatchesDto {
  candidates: PublicRequestMatchDto[];
}
