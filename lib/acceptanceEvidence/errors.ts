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

// ⚠️ `AcceptanceEvidenceNotInReviewError` WAS HERE (MOTIR-1625) and retired with
// `acceptanceEvidenceService.decide` (MOTIR-4950). It held an approval to the
// `in_review` status because that path wrote `done` itself. The acceptance gate is a
// question from the moment a receipt is published, and what approving it writes is
// decided per run shape (`approval-gates.md` §1, the MOTIR-5787 amendment, point 7) —
// so a story still being built is answerable, and the rollup writes `done` later.

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

/**
 * A publish reported a `commitSha` that is not a commit id (MOTIR-5619) — the
 * receipt's CITATION, and the one thing tying the recording to the code it
 * shows. Refused on the SERVICE, so both entry points (the MCP tool and the
 * HTTP route) answer identically; `lib/git/commitSha.ts` supplies the pattern
 * and the reason, shared with `publish_test_instructions`. → 400.
 *
 * ⚠️ THE FORMAT IS ALL THIS RULES ON. A 40-character string of valid hex naming
 * no commit anywhere passes — which is exactly how this defect surfaced, a real
 * short sha completed with invented characters. The panel renders the first
 * seven characters as plain unlinked text, so a reader could not have told.
 * Verifying EXISTENCE is a separate, larger question and its own card.
 */
export class AcceptanceEvidenceCommitShaError extends AcceptanceEvidenceError {
  readonly code = 'ACCEPTANCE_EVIDENCE_INVALID_COMMIT_SHA' as const;
  readonly status = 400;
  constructor(reason: string) {
    super(`commitSha: ${reason}`);
    this.name = 'AcceptanceEvidenceCommitShaError';
  }
}

/**
 * The story's CURRENT receipt is `approved` — a human watched that recording and
 * signed it — so it is FROZEN and a publish may not supersede it (MOTIR-2764).
 *
 * This is the layer that cannot be bypassed. `markSupersededByWorkItem` carries
 * no status predicate, so before this error existed ANY publish flipped the
 * approved row `isCurrent: false`, unlinked its attachments, and left the
 * orphan-GC to reclaim the very bytes the approval was given on — triggered by
 * something as small as a one-line fix to an `acceptance*.spec.ts`.
 *
 * **This is NOT a failure condition.** An accepted story is the expected steady
 * state for most specs most of the time, so the CI publisher recognises this
 * `code`, reports the skip and exits 0 (MOTIR-2768). It is a 409 because the
 * request conflicts with the resource's current state — the caller is not wrong,
 * there is simply nothing left to write.
 *
 * `pending` and `changes_requested` receipts remain freely replaceable: a story
 * still in review must keep getting the current truth on every run.
 *
 * Policy: `docs/decisions/acceptance-receipt-lifecycle.md` §2 and §4.
 */
export class AcceptanceEvidenceAlreadyApprovedError extends AcceptanceEvidenceError {
  readonly code = 'ACCEPTANCE_EVIDENCE_ALREADY_APPROVED' as const;
  readonly status = 409;
  constructor(
    /** The story whose receipt is frozen — the CI log names it, so a reader can act. */
    readonly storyKey: string,
  ) {
    super(`${storyKey} has an approved acceptance receipt; it is frozen and was not superseded.`);
    this.name = 'AcceptanceEvidenceAlreadyApprovedError';
  }
}
