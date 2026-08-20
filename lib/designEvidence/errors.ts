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
        ? `A design result attaches to the card that produced it, not to a ${kind}.`
        : `A design result attaches to the card that produced it; this ${kind} has ` +
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
