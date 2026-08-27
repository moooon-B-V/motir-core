/**
 * The opaque cursor for the public CHANGELOG's "load more" (Story 8.9 ·
 * Subtask 8.9.3 · `docs/decisions/public-follow-and-changelog.md` §3).
 *
 * Same shape and same codec as `roadmapCursor.ts` — a base64url JSON tuple —
 * so the two public paged reads encode positions the same way and a reader of
 * one recognises the other. What differs is the POSITION it carries.
 *
 * `(shippedAt, key)`, and both halves are load-bearing. `shippedAt` is the
 * sort key; `key` is the tiebreak, because a timestamp alone is NOT a total
 * order — two revisions written in the same millisecond tie, and an unbroken
 * tie makes cursor paging non-deterministic, so a page boundary landing
 * mid-tie skips or repeats an entry (PRODECT_FINDINGS #38, the reasoning
 * `workItemRevisionRepository.listByWorkItem` records for the same reason).
 */
export interface ChangelogCursorToken {
  /** ISO 8601 — the last entry on the previous page. */
  shippedAt: string;
  /** That entry's project-scoped numeric key. */
  key: number;
}

/**
 * A cursor that did not decode. Thrown rather than swallowed so the route
 * answers 400 instead of silently restarting from the top — a paging bug that
 * repeats the newest page for ever is much harder to notice than an error.
 */
export class InvalidChangelogCursorError extends Error {
  readonly code = 'INVALID_CHANGELOG_CURSOR';

  constructor() {
    super('Invalid changelog cursor');
    this.name = 'InvalidChangelogCursorError';
  }
}

/** Encode a `(shippedAt, key)` position into the opaque page token. */
export function encodeChangelogCursor(cursor: ChangelogCursorToken): string {
  return Buffer.from(JSON.stringify([cursor.shippedAt, cursor.key]), 'utf8').toString('base64url');
}

/**
 * Decode the opaque token back to its position. Every field is validated:
 * `shippedAt` must parse to a real date and `key` must be a finite, positive
 * integer, so a hand-edited token cannot reach the SQL as `NaN` or `Invalid
 * Date` — both of which compare FALSE against every row and would silently
 * return an empty page rather than an error.
 */
export function decodeChangelogCursor(raw: string): ChangelogCursorToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidChangelogCursorError();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new InvalidChangelogCursorError();
  const [shippedAt, key] = parsed as [unknown, unknown];
  if (typeof shippedAt !== 'string' || shippedAt.length === 0) {
    throw new InvalidChangelogCursorError();
  }
  if (Number.isNaN(new Date(shippedAt).getTime())) throw new InvalidChangelogCursorError();
  if (typeof key !== 'number' || !Number.isInteger(key) || key <= 0) {
    throw new InvalidChangelogCursorError();
  }
  return { shippedAt, key };
}
