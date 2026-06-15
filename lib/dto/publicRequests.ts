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
