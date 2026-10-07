// Typed errors for the door motir-ai comments on its own filed bugs through
// (`POST /api/internal/ai/work-items/{key}/comments`, MOTIR-7722). The route
// maps the stable `code` to a status.

/**
 * A repeat planning failure tried to comment on the bug Motir filed for the
 * first one, and that bug is closed — archived, or in its project's done
 * category (MOTIR-7722). → 409: motir-ai reads it as "file a new bug", since a
 * closed bug is one somebody decided about, and a new occurrence is news.
 */
export class FiledBugClosedError extends Error {
  readonly code = 'FILED_BUG_CLOSED' as const;
  constructor(readonly identifier: string) {
    super(`${identifier} is closed; file a new bug instead of commenting on it.`);
    this.name = 'FiledBugClosedError';
  }
}
