// Typed errors for the story-acceptance evidence domain (Story MOTIR-1627 ·
// Subtask MOTIR-1629). The route maps each `code` to an HTTP status via the
// `status` field, matching the `readonly code` convention the other domains use
// (mirrors lib/blob/errors.ts). The upload path additionally reuses
// FileTooLargeError / UnsupportedFileTypeError from lib/blob/errors.

export abstract class AcceptanceEvidenceError extends Error {
  abstract readonly code: string;
  /** HTTP status the route should return. */
  abstract readonly status: number;
}

/**
 * No current acceptance evidence resolves for the caller — missing id, a story
 * with no evidence yet, or a row in another workspace (the RLS gate hides it).
 * All read identically as 404 (finding #44: "you can't see it" is
 * indistinguishable from "it doesn't exist").
 */
export class AcceptanceEvidenceNotFoundError extends AcceptanceEvidenceError {
  readonly code = 'ACCEPTANCE_EVIDENCE_NOT_FOUND' as const;
  readonly status = 404;
  constructor(ref: string) {
    super(`Acceptance evidence "${ref}" was not found.`);
    this.name = 'AcceptanceEvidenceNotFoundError';
  }
}

/**
 * Acceptance evidence is a STORY-level artifact (Principle #18 — review at the
 * Story level). Attaching it to an epic / subtask / bug is rejected. → 422.
 */
export class AcceptanceEvidenceNotAStoryError extends AcceptanceEvidenceError {
  readonly code = 'ACCEPTANCE_EVIDENCE_NOT_A_STORY' as const;
  readonly status = 422;
  constructor(kind: string) {
    super(`Acceptance evidence attaches to a story, not a ${kind}.`);
    this.name = 'AcceptanceEvidenceNotAStoryError';
  }
}

/**
 * A register-mode publish (MOTIR-1681) reported a blob pathname OUTSIDE this
 * story's `acceptance/<workspaceId>/<storyId>/` prefix — a caller trying to
 * register an arbitrary / cross-tenant blob. Rejected before any DB write. → 400.
 */
export class AcceptanceEvidencePathnameError extends AcceptanceEvidenceError {
  readonly code = 'ACCEPTANCE_EVIDENCE_INVALID_PATHNAME' as const;
  readonly status = 400;
  constructor(pathname: string) {
    super(`The blob pathname "${pathname}" is not within this story's acceptance prefix.`);
    this.name = 'AcceptanceEvidencePathnameError';
  }
}

/**
 * A register-mode publish (MOTIR-1681) reported a pathname whose blob does not
 * exist in the store — the client upload never completed (or the pathname is
 * fabricated). The server `head`s every artifact before recording it. → 400.
 */
export class AcceptanceEvidenceBlobMissingError extends AcceptanceEvidenceError {
  readonly code = 'ACCEPTANCE_EVIDENCE_BLOB_MISSING' as const;
  readonly status = 400;
  constructor(pathname: string) {
    super(`No uploaded blob was found at "${pathname}".`);
    this.name = 'AcceptanceEvidenceBlobMissingError';
  }
}
