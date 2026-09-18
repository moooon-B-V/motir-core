// Typed errors for the design-result domain (Story MOTIR-2664 · Subtask
// MOTIR-2666). The route maps each `code` to an HTTP status via the `status`
// field, matching the convention the other domains use (mirrors
// lib/acceptanceEvidence/errors.ts). The publish path additionally reuses
// FileTooLargeError / UnsupportedFileTypeError from lib/blob/errors.

export abstract class DesignEvidenceError extends Error {
  abstract readonly code: string;
  /** HTTP status the route should return. */
  abstract readonly status: number;
}

/**
 * No design result resolves for the caller — missing id, an item with none yet,
 * or a row in another workspace (the RLS gate hides it). All read identically as
 * 404 (finding #44: "you can't see it" is indistinguishable from "it doesn't
 * exist").
 */
export class DesignEvidenceNotFoundError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_NOT_FOUND' as const;
  readonly status = 404;
  constructor(ref: string) {
    super(`Design result "${ref}" was not found.`);
    this.name = 'DesignEvidenceNotFoundError';
  }
}

/**
 * A design result belongs to the CARD THAT PRODUCED IT, so its target must be a
 * leaf (`subtask` / `task` / `bug`). Attaching one to a container — an `epic` or
 * a `story` — is rejected: a story has many designs, one per design subtask, and
 * rolling them up would pile unrelated surfaces onto one panel and lose which
 * card produced which (docs/decisions/design-result.md §3).
 *
 * Note this is the OPPOSITE of `AcceptanceEvidenceNotAStoryError`, deliberately:
 * a story has exactly one end-to-end receipt, and many designs. → 422.
 */
export class DesignEvidenceNotALeafError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_NOT_A_LEAF' as const;
  readonly status = 422;
  /**
   * @param kind the target's kind
   * @param byKind true when the KIND can never be a leaf (`epic` / `story`);
   *   false when a leaf-CAPABLE kind is a container because it has children.
   *   The two send an operator to different places, so they read differently
   *   (MOTIR-3146).
   */
  constructor(kind: string, byKind = true) {
    super(
      byKind
        ? `A design result attaches to the work item that produced it, not to a ${kind}.`
        : `A design result attaches to the work item that produced it; this ${kind} has ` +
            `children, so it is a container. Address the child that produced the assets.`,
    );
    this.name = 'DesignEvidenceNotALeafError';
  }
}

/**
 * The target is a leaf, but not a CHILD of the container the publisher named
 * (MOTIR-3177). → 422.
 *
 * A PARENT-RUN pull request's branch names the container, so the publisher
 * re-addresses each asset to the child whose commit produced it, reading the
 * key out of that commit's subject. A commit subject is prose written by hand,
 * and a mistyped key resolves to a real, unrelated card that is perfectly
 * publishable in every other respect — at which point the design of six swept
 * areas lands on somebody's billing task. So the publisher declares the
 * container it is publishing FOR and the tenant, which is the only party that
 * can see the tree, checks the relationship.
 *
 * A wrong key is the ONLY thing this can catch, which is why it refuses rather
 * than falling back: the container's own children are exactly the cards that
 * can have produced its branch's assets.
 */
export class DesignEvidenceNotAChildError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_NOT_A_CHILD' as const;
  readonly status = 422;
  constructor(identifier: string, containerIdentifier: string) {
    super(
      `${identifier} is not a child of ${containerIdentifier}, so it cannot have produced ` +
        `that container's design assets.`,
    );
    this.name = 'DesignEvidenceNotAChildError';
  }
}

/**
 * A publish reported a `commitSha` that is not a commit id (MOTIR-5620) — the
 * design result's CITATION, and the only thing tying the mocks a reviewer is
 * approving to the code they were drawn against. Refused on the SERVICE, so both
 * entry points (the MCP tool and the HTTP route) answer identically;
 * `lib/git/commitSha.ts` supplies the pattern and the reason, shared with the
 * acceptance receipt and `publish_test_instructions`. → 400.
 *
 * ⚠️ IT IS ALSO THE IDEMPOTENCY KEY, which is the half that damages a person's
 * work rather than the data. A redelivery spelling one commit two ways used to
 * supersede the current result AND mark the prior version's `awaiting` gate
 * `superseded` — so a reviewer mid-review lost the question they were answering,
 * for a value that differed by a trailing newline. Storing the canonical form is
 * what makes two spellings one key.
 *
 * ⚠️ THE FORMAT IS ALL THIS RULES ON. A 40-character string of valid hex naming
 * no commit anywhere passes. Verifying EXISTENCE needs the host, costs an API
 * call on the publish path, and is its own card.
 */
export class DesignEvidenceCommitShaError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_INVALID_COMMIT_SHA' as const;
  readonly status = 400;
  constructor(reason: string) {
    super(`commitSha: ${reason}`);
    this.name = 'DesignEvidenceCommitShaError';
  }
}

/**
 * A publish reported a blob pathname OUTSIDE this item's
 * `design/<workspaceId>/<workItemId>/` prefix — a caller trying to register an
 * arbitrary / cross-tenant blob. Rejected before any DB write. → 400.
 */
export class DesignEvidencePathnameError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_INVALID_PATHNAME' as const;
  readonly status = 400;
  constructor(pathname: string) {
    super(`The blob pathname "${pathname}" is not within this item's design prefix.`);
    this.name = 'DesignEvidencePathnameError';
  }
}

/**
 * A publish reported a pathname whose blob does not exist in the store — the
 * client upload never completed (or the pathname is fabricated). The server
 * `head`s every artifact before recording it. → 400.
 */
export class DesignEvidenceBlobMissingError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_BLOB_MISSING' as const;
  readonly status = 400;
  constructor(pathname: string) {
    super(`No uploaded blob was found at "${pathname}".`);
    this.name = 'DesignEvidenceBlobMissingError';
  }
}

/**
 * A publish carried no assets at all. The publisher is expected to skip the
 * register call entirely when a PR changed nothing under `design/**`, so an
 * empty set reaching the service is a caller bug, not an empty result to
 * record — recording it would supersede a real design result with nothing. → 400.
 */
export class DesignEvidenceEmptyError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_EMPTY' as const;
  readonly status = 400;
  constructor() {
    super('A design result must carry at least one asset.');
    this.name = 'DesignEvidenceEmptyError';
  }
}

/**
 * Two publishes for the same work item raced and this one lost the
 * `design_evidence_one_current_per_item` partial-unique slot. The DB constraint
 * is what makes two current rows unrepresentable; this translates the lost race
 * into a typed domain error instead of letting a raw Prisma `P2002` escape the
 * service (the concurrency rule in CLAUDE.md). → 409, safe to retry.
 */
export class DesignEvidenceSupersedeConflictError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_SUPERSEDE_CONFLICT' as const;
  readonly status = 409;
  constructor(workItemId: string) {
    super(`Another publish for "${workItemId}" won the current-result slot; retry.`);
    this.name = 'DesignEvidenceSupersedeConflictError';
  }
}

/**
 * A withdrawal was asked for on a work item that has no CURRENT design result —
 * it never had one, or its result has already been withdrawn (MOTIR-3215). → 404.
 *
 * Distinct from {@link DesignEvidenceNotFoundError}, which answers "no such work
 * item / not visible to you". Here the item resolved fine and the caller may see
 * it; there is simply nothing to take back. Collapsing the two would make a
 * double-withdraw indistinguishable from a permissions failure, and the second
 * press of a button is exactly when a caller hits this.
 */
export class DesignEvidenceNoCurrentResultError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_NO_CURRENT_RESULT' as const;
  readonly status = 404;
  constructor(identifier: string) {
    super(`${identifier} has no current design result to withdraw.`);
    this.name = 'DesignEvidenceNoCurrentResultError';
  }
}

// ── AMENDMENT 4 (MOTIR-5491): what a design result IS, and when it may exist ──
//
// `docs/decisions/design-result.md` AMENDMENT 4. A result is one or more `mock`
// assets plus exactly one `note_file`; the `.png` export and the inline `noteMd`
// are RETIRED, and a publish is accepted only while an open work item is
// `blocked_by` the design card. A retired input is REFUSED, never silently
// dropped: an agent cannot tell an ignored field from an accepted one, so a
// quiet drop would come back as a report that a screenshot was published.

/**
 * An `image` asset — the `.png` export AMENDMENT 4 retired. The enum value stays
 * so stored rows keep reading; a NEW publish (or grant) naming it is refused. → 422.
 */
export class DesignEvidenceImageRetiredError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_IMAGE_RETIRED' as const;
  readonly status = 422;
  constructor(sourcePath: string) {
    super(
      `"${sourcePath}" is an image asset, and a design result no longer carries a screenshot — ` +
        'publish the mock(s) and the note file only (design-result.md AMENDMENT 4).',
    );
    this.name = 'DesignEvidenceImageRetiredError';
  }
}

/**
 * An inline `noteMd` — retired: the result shows the published `note_file` as a
 * link instead. Refused whether empty or not, because its presence is the signal
 * that the caller is still following the old contract. → 422.
 */
export class DesignEvidenceNoteMdRetiredError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_NOTE_MD_RETIRED' as const;
  readonly status = 422;
  constructor() {
    super(
      'A design result no longer takes `noteMd` — drop it and publish the notes file as the one ' +
        '`note_file` asset; the result links to it (design-result.md AMENDMENT 4).',
    );
    this.name = 'DesignEvidenceNoteMdRetiredError';
  }
}

/** A publish with no `mock` asset — the mock IS the result. → 422. */
export class DesignEvidenceMockRequiredError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_MOCK_REQUIRED' as const;
  readonly status = 422;
  constructor() {
    super(
      'A design result must carry at least one `mock` asset (the `*.mock.html` — for a change, ' +
        'the new delta mock).',
    );
    this.name = 'DesignEvidenceMockRequiredError';
  }
}

/** A publish with zero, or more than one, `note_file` asset. → 422. */
export class DesignEvidenceNoteFileRequiredError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_NOTE_FILE_REQUIRED' as const;
  readonly status = 422;
  constructor(count: number) {
    super(
      `A design result carries exactly ONE \`note_file\` asset (the area's design-notes.md); this ` +
        `publish carries ${count}.`,
    );
    this.name = 'DesignEvidenceNoteFileRequiredError';
  }
}

/**
 * No open work item is `blocked_by` the design card, so a result would raise an
 * approval nobody's work waits on. The request is well-formed; the TREE is in a
 * state where the result has no one to serve. → 409.
 */
export class DesignEvidenceNothingWaitsError extends DesignEvidenceError {
  readonly code = 'DESIGN_EVIDENCE_NOTHING_WAITS' as const;
  readonly status = 409;
  constructor(identifier: string) {
    super(
      `No open work item is blocked_by ${identifier}, so it publishes no design result — its pull ` +
        'request is its review. Publish only when work waits on the design (design-result.md ' +
        'AMENDMENT 4).',
    );
    this.name = 'DesignEvidenceNothingWaitsError';
  }
}

/**
 * The design card is CLOSED — its status is in the `done` category (`cancelled`
 * included), so it accepts no new design result and gives up none: a publish, an
 * upload-grant mint and a withdrawal are all refused (MOTIR-5556;
 * `docs/decisions/approval-gates.md` §6c SECOND AMENDMENT). → 409.
 *
 * The message names BOTH ways forward, because the one who hits this is usually
 * an agent, and an agent told only "not allowed" retries or improvises. Each way
 * leaves a visible record: reopening is a status change the card's history
 * keeps, and a new design card leaves this one standing as what was decided.
 */
export class DesignCardClosedError extends DesignEvidenceError {
  readonly code = 'DESIGN_CARD_CLOSED' as const;
  readonly status = 409;
  constructor(identifier: string, statusKey: string, reason?: string) {
    super(
      `${identifier} ${reason ?? `is ${statusKey}`}, so its design is decided and it accepts no ` +
        'new design result, upload or withdrawal. To change it, either reopen the card by hand ' +
        `(move it out of ${statusKey}), or propose a new design card beside the card that needs ` +
        `it, relates_to ${identifier}.`,
    );
    this.name = 'DesignCardClosedError';
  }

  /**
   * The SECOND thing that settles a design: somebody approved the card's current
   * result, and the card still stands on that approval (Subtask MOTIR-5661;
   * AMENDMENT 6 Q3). Same code, same status, same two ways forward — only the
   * clause naming WHY changes, because *"MOTIR-1 is in_review, so its design is
   * decided"* would be false, and an agent reading a false reason looks for the
   * wrong way out.
   *
   * A separate factory rather than a second error class, deliberately: this card
   * introduces no new error vocabulary, so every consumer that already maps
   * `DESIGN_CARD_CLOSED` keeps working with nothing to add.
   */
  static becauseApproved(identifier: string, statusKey: string): DesignCardClosedError {
    return new DesignCardClosedError(
      identifier,
      statusKey,
      'has an APPROVED design result and is still in review',
    );
  }
}
