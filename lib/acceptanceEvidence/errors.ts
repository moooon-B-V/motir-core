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
 * The story takes no new receipt right now (MOTIR-5872) — the acceptance twin of
 * `DesignCardClosedError`, and it refuses for exactly the two reasons that one
 * does. → 409: the caller is not wrong, the story's state conflicts with a new
 * recording.
 *
 * · **The story is CLOSED** — in a terminal status. Its acceptance is decided and
 *   it has shipped; a later recording would be a question nobody can answer.
 *   Reopening the story by hand is the way back.
 * · **The story is still STANDING ON an approved receipt** — the current receipt
 *   is `approved`, the story is at or above `implemented`, and a pull request of
 *   its is still open. That merge would ship with whatever receipt is current,
 *   so a republish in that window would carry a recording nobody approved to
 *   `done` ({@link AcceptanceEvidenceStoryClosedError.becauseApproved}).
 *
 * ⚠️ IT REPLACES `AcceptanceEvidenceAlreadyApprovedError` (MOTIR-2764), which
 * refused EVERY publish over an approved receipt, for ever. That froze the STORY
 * rather than the recording: a story whose merge did not land and came back to
 * be reworked could never record again. What MOTIR-2764 actually protected — the
 * approved recording's BYTES — is now protected by the supersede keeping them
 * (`acceptanceEvidenceService`'s `persistEvidence`), the way an approved design
 * version is pinned. Policy: `docs/decisions/acceptance-receipt-lifecycle.md`
 * AMENDMENT 1.
 */
export class AcceptanceEvidenceStoryClosedError extends AcceptanceEvidenceError {
  readonly code = 'ACCEPTANCE_EVIDENCE_STORY_CLOSED' as const;
  readonly status = 409;
  constructor(
    /** The story — the log names it, so a reader can act. */
    readonly storyKey: string,
    statusKey: string,
    reason?: string,
  ) {
    super(
      `${storyKey} ${reason ?? `is ${statusKey}`}, so it takes no new acceptance receipt. ` +
        `To record again, reopen the story by hand (move it out of ${statusKey}) and redo ` +
        'the work; the approved recording stays on record either way.',
    );
    this.name = 'AcceptanceEvidenceStoryClosedError';
  }

  /** The story stands on an APPROVED receipt while its pull request is still open. */
  static becauseApproved(storyKey: string, statusKey: string): AcceptanceEvidenceStoryClosedError {
    return new AcceptanceEvidenceStoryClosedError(
      storyKey,
      statusKey,
      `has an APPROVED acceptance receipt and an open pull request that would ship with it`,
    );
  }
}
