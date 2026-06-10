// Typed errors for the labels domain (Story 5.4 · Subtask 5.4.2). Kept in
// their own file so callers — route handlers, server actions, server
// components — can import them without pulling in the Prisma client.
//
// Per CLAUDE.md, the service throws these and the route layer translates the
// stable `code` to an HTTP status (all three are validation rejections):
//   InvalidLabelNameError   → 422 (blank, or contains whitespace — labels are
//                                  single tokens; the message names the hyphen
//                                  convention, the Jira rule)
//   LabelNameTooLongError   → 422 (over LABEL_NAME_MAX_LENGTH characters)
//   LabelLimitExceededError → 422 (the per-issue cap — a recorded sanity
//                                  guard; Jira documents no per-issue cap)
//
// The hide-gates reuse the existing domains: a missing / cross-workspace /
// non-browsable issue is WorkItemNotFoundError (finding #44 — 404, no
// existence leak); a browser without edit rights is
// ProjectAccessDeniedError('edit') (403, read-only).

export class InvalidLabelNameError extends Error {
  readonly code = 'INVALID_LABEL_NAME' as const;
  constructor(name: string) {
    super(
      name.trim().length === 0
        ? 'A label name must not be empty.'
        : `Label "${name}" must not contain spaces — join words with hyphens (e.g. "perf-q3").`,
    );
    this.name = 'InvalidLabelNameError';
  }
}

export class LabelNameTooLongError extends Error {
  readonly code = 'LABEL_NAME_TOO_LONG' as const;
  constructor(name: string, maxLength: number) {
    super(`Label "${name.slice(0, maxLength)}…" is too long (${maxLength} characters max).`);
    this.name = 'LabelNameTooLongError';
  }
}

export class LabelLimitExceededError extends Error {
  readonly code = 'LABEL_LIMIT_EXCEEDED' as const;
  constructor(limit: number) {
    super(`An issue can carry at most ${limit} labels.`);
    this.name = 'LabelLimitExceededError';
  }
}
