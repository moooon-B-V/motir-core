// Typed errors for the project-tags domain (Story 6.13 · Subtask 6.13.5). Kept
// in their own file so callers — route handlers, server actions, server
// components — can import them without pulling in the Prisma client.
//
// Per CLAUDE.md, the service throws these and the route layer translates the
// stable `code` to an HTTP status (see lib/projectTags/errorResponse.ts):
//   InvalidProjectTagError   → 422 (a slug outside the curated vocabulary — the
//                                   admin may only assign known topics)
//   TooManyProjectTagsError  → 422 (over the per-project cap)
//
// The hide / permission gates reuse the existing project domain: a missing /
// cross-workspace project is ProjectNotFoundError (404, no existence leak); a
// browser without manage rights is NotProjectAdminError (403, the 6.4 two-tier
// admin gate); a viewer who can't even browse is ProjectAccessDeniedError.

export class InvalidProjectTagError extends Error {
  readonly code = 'INVALID_PROJECT_TAG' as const;
  constructor(slug: string) {
    super(`"${slug}" is not a valid project topic.`);
    this.name = 'InvalidProjectTagError';
  }
}

export class TooManyProjectTagsError extends Error {
  readonly code = 'TOO_MANY_PROJECT_TAGS' as const;
  constructor(max: number) {
    super(`A project may carry at most ${max} topics.`);
    this.name = 'TooManyProjectTagsError';
  }
}
