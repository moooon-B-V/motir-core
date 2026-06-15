// Typed errors for the public-requests domain (Story 6.12 · Subtask 6.12.6 —
// upvote + comment on a public request). Kept in their own file so callers
// (route handlers) import them without pulling in the Prisma client.
//
// The route layer translates the stable `code` to an HTTP status:
//   PublicRequestNotFoundError → 404 (the request id doesn't resolve to a work
//                                     item — no existence leak, the 404-not-403
//                                     posture)
// Access is gated by `projectAccessService` (ProjectNotFoundError → 404 on a
// non-public project; ProjectAccessDeniedError('edit') → 403 when the grant is
// denied), and an empty comment body reuses the comments domain's
// EmptyCommentBodyError (→ 422).

export class PublicRequestNotFoundError extends Error {
  readonly code = 'PUBLIC_REQUEST_NOT_FOUND' as const;
  constructor(workItemId: string) {
    super(`Public request ${workItemId} not found.`);
    this.name = 'PublicRequestNotFoundError';
  }
}
