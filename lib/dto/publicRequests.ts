// Wire DTOs for the public-requests domain (Story 6.12 · Subtask 6.12.6). What
// crosses the HTTP boundary for the upvote toggle — no Prisma row shape leaks.
// (The public-request COMMENT write returns the shared CommentDTO.)

/**
 * The result of toggling an upvote on a public request. `voted` is the caller's
 * NEW state (true = they now upvote it, false = they just removed their vote);
 * `voteCount` is the request's resulting total across every account (the demand
 * signal the 6.11.3 triage queue sorts by).
 */
export interface PublicRequestVoteResultDTO {
  voted: boolean;
  voteCount: number;
}

/**
 * One pending public request as a VISITOR reads it in Requested features
 * (Story MOTIR-6171 · MOTIR-6768; `docs/decisions/public-request-board-retired.md`
 * Decision 2). The retired motir.co board's "Submitted" set: in triage,
 * attributed, not archived, not done, not snoozed.
 *
 * ⚠️ NAME ONLY. `submitterName` is the submitter's display name or the neutral
 * `PERSON_FALLBACK_LABEL` — never an email or any part of one (MOTIR-6646).
 * No other person field is carried.
 */
export interface VisitorPendingRequestDto {
  id: string;
  /** The full work-item identifier, e.g. `MOTIR-42`. */
  identifier: string;
  key: number;
  title: string;
  kind: string;
  submitterName: string;
  /** When the request was filed, ISO-8601. */
  createdAt: string;
  /** Upvotes across every account — the order's leading key. */
  voteCount: number;
  /** Whether the READING Visitor has upvoted it. */
  voted: boolean;
}

/**
 * One page of a public project's pending requests for its Visitor — ordered by
 * votes, then the most recently triaged, then id — with the whole set's `total`
 * (never the page length) and the opaque `nextCursor` for "Load more", or null
 * on the last page.
 */
export interface VisitorPendingRequestPageDto {
  items: VisitorPendingRequestDto[];
  total: number;
  nextCursor: string | null;
}
