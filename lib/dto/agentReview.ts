// What the REVIEW RUN's two routes answer (Story MOTIR-1626 · MOTIR-6821;
// `docs/decisions/hosted-agent-run.md` §8.2 / §8.4).

import type { ReviewVerdict } from '@/lib/dispatch/reviewPromptTemplate';

/** One pull request the review is about, at its REVIEWED head. */
export interface ReviewPullRequestDto {
  /** `owner/name`. */
  repository: string;
  number: number;
  /** The head the gate's `subjectVersion` names — never a later one. */
  headSha: string;
  baseBranch: string | null;
  headBranch: string | null;
  url: string;
}

/** `GET …/review-prompt` — the brief, and the coordinates the launcher checks out. */
export interface ReviewPromptDto {
  key: string;
  gateId: string;
  /** The version under review — what the verdict must name back. */
  subjectVersion: string;
  pullRequests: ReviewPullRequestDto[];
  prompt: string;
}

/** What the verdict route did with an ACCEPTED verdict. */
export interface AgentReviewVerdictResultDto {
  key: string;
  gateId: string;
  verdict: ReviewVerdict;
  /** The gate's state after the decision — `approved` or `changes_requested`. */
  state: 'approved' | 'changes_requested';
  subjectVersion: string;
  decidedAt: string;
}
