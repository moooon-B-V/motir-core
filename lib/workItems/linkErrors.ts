// Typed errors for the work-item-link domain (Subtask 1.4.3). Kept in their
// own file (sibling to errors.ts) so callers — the service layer (1.4.4),
// route handlers, server actions — can import them without pulling in the
// Prisma client.
//
// These wrap the DB-layer reality: the cycle / self-link / workspace rules
// are enforced by Postgres triggers (prisma/sql/work_item_link_triggers.sql),
// which reject with SQLSTATE 23514 + a WI_LINK_* message marker.
// workItemLinkRepository catches those at its edge and rethrows the matching
// class here, so the service layer never inspects raw Postgres error codes
// (the 4-layer rule). Prisma's P2002 (unique constraint on fromId/toId/kind)
// also translates here, into DuplicateLinkError.
//
// Every class carries a string `tag` discriminant. The service layer can
// `switch (err.tag)` over a `WorkItemLinkError` union exhaustively without
// `instanceof` chains. `code` mirrors `tag` and is what the route layer
// (Epic 2) maps to an HTTP status. Mirrors the shape of errors.ts.

export type WorkItemLinkErrorTag =
  | 'WORK_ITEM_LINK_CYCLE'
  | 'CROSS_WORKSPACE_LINK'
  | 'WORKSPACE_MISMATCH_LINK'
  | 'SELF_LINK'
  | 'DUPLICATE_LINK'
  | 'WORK_ITEM_LINK_NOT_FOUND';

/**
 * Base class for every work-item-link typed error. Concrete subclasses set a
 * literal `tag` (the discriminant) and a matching `code`.
 */
export abstract class WorkItemLinkError extends Error {
  abstract readonly tag: WorkItemLinkErrorTag;
  abstract readonly code: WorkItemLinkErrorTag;
}

/**
 * Adding this `is_blocked_by` link would close a dependency cycle. Scoped to
 * `is_blocked_by` only — the other kinds (`relates_to`, `duplicates`,
 * `clones`) are allowed to be reciprocal by design.
 *
 * Carries the attempted (fromId, toId, kind) for diagnostics so the service
 * layer can surface a precise message ("PROD-3 is_blocked_by PROD-1 would
 * close the chain PROD-1 → PROD-2 → PROD-3"). The route layer translates
 * this to 409 Conflict per the WorkItemError → HTTP mapping convention.
 */
export class WorkItemLinkCycleError extends WorkItemLinkError {
  readonly tag = 'WORK_ITEM_LINK_CYCLE' as const;
  readonly code = 'WORK_ITEM_LINK_CYCLE' as const;
  readonly attempted: { fromId: string; toId: string; kind: string };
  constructor(
    attempted: { fromId: string; toId: string; kind: string },
    message = 'Adding this link would create a dependency cycle.',
  ) {
    super(message);
    this.name = 'WorkItemLinkCycleError';
    this.attempted = attempted;
  }
}

/**
 * The two referenced work items live in different workspaces — cross-
 * workspace links are forbidden (RLS tenancy boundary). Surfaced from the
 * WI_LINK_CROSS_WORKSPACE trigger marker.
 *
 * ⚠️ **This is a DB-BACKSTOP error, not the answer a caller gets.** Decided
 * 2026-08-17 (MOTIR-2919). `workItemsService.linkWorkItems` and the
 * create-with-links path both answer `WorkItemNotFoundError` for a far end in
 * another workspace. Reaching this class means the SERVICE guard was bypassed
 * — a direct `workItemLinkRepository.create`, or a service bug — and the
 * trigger caught it (`tests/integration/work-items/link-repository.test.ts`).
 *
 * **Why the service does not raise it.** Telling a caller "cannot link ACROSS
 * WORKSPACES" confirms that the id they named resolves in some other tenant.
 * That is the existence oracle the 404-not-403 contract refuses everywhere
 * else in this codebase — see `docs/decisions/public-api-conventions.md` §
 * *Errors* ("a 403 on a resource in another workspace confirms that the
 * resource EXISTS"). The public API had already applied it to this exact code
 * (`lib/api/v1/errors.ts`: `CROSS_WORKSPACE_LINK: 404`, *"404 on the TARGET
 * key, not 403"*), and `app/api/v1/work-items/[key]/links/route.ts` already
 * DOCUMENTED the service as answering 404. The service was the layer that had
 * drifted; MOTIR-2919 aligned it rather than deciding anything new.
 *
 * **What was weighed against it.** The typed error carries a message a user
 * could act on in the one case that is not an attack — an id they legitimately
 * hold in a workspace they are also a member of. It was rejected because the
 * message is a constant that names no workspace and offers no link, so it is
 * barely more actionable than "not found"; making it genuinely actionable
 * would mean naming the other tenant, which is a strictly larger leak. A
 * membership-aware variant (distinguish only when the caller is a member of
 * BOTH workspaces) is the door left open — it needs a deliberate privileged
 * read and a decision of its own, and nobody has asked for one.
 *
 * **Do not "restore" the service-layer throw to make a test green.** The
 * assertions that used to expect it now say so in a comment; changing them
 * back reopens a settled question and reintroduces the oracle.
 */
export class CrossWorkspaceLinkError extends WorkItemLinkError {
  readonly tag = 'CROSS_WORKSPACE_LINK' as const;
  readonly code = 'CROSS_WORKSPACE_LINK' as const;
  constructor(message = 'Cannot link work items across workspaces.') {
    super(message);
    this.name = 'CrossWorkspaceLinkError';
  }
}

/**
 * The link row's denormalized `workspaceId` doesn't match `fromItem.workspaceId`.
 * This is a service-layer bug indicator — the row would slip through workspace-
 * scoped RLS reads as if it belonged to the wrong tenant. Surfaced from the
 * WI_LINK_WORKSPACE_MISMATCH trigger marker; routes should treat it as a 500
 * (internal invariant violation), not a 400.
 */
export class WorkspaceMismatchLinkError extends WorkItemLinkError {
  readonly tag = 'WORKSPACE_MISMATCH_LINK' as const;
  readonly code = 'WORKSPACE_MISMATCH_LINK' as const;
  constructor(message = 'Link workspaceId does not match the source work item workspaceId.') {
    super(message);
    this.name = 'WorkspaceMismatchLinkError';
  }
}

/**
 * `fromId === toId` — a work item cannot link to itself. Surfaced from the
 * WI_LINK_SELF trigger marker.
 */
export class SelfLinkError extends WorkItemLinkError {
  readonly tag = 'SELF_LINK' as const;
  readonly code = 'SELF_LINK' as const;
  constructor(message = 'A work item cannot link to itself.') {
    super(message);
    this.name = 'SelfLinkError';
  }
}

/**
 * A link with the same (fromId, toId, kind) already exists. Translated from
 * Prisma P2002 on the @@unique([fromId, toId, kind]) constraint. Note that
 * the SAME pair with a DIFFERENT kind is allowed — e.g., A is_blocked_by B
 * AND A relates_to B can coexist.
 */
export class DuplicateLinkError extends WorkItemLinkError {
  readonly tag = 'DUPLICATE_LINK' as const;
  readonly code = 'DUPLICATE_LINK' as const;
  constructor(message = 'A link of this kind already exists between these work items.') {
    super(message);
    this.name = 'DuplicateLinkError';
  }
}

/**
 * No work-item link matched the id looked up (Subtask 1.4.4). Thrown by
 * `unlinkWorkItems` when the target link is already gone. Mirrors the shape
 * of WorkItemNotFoundError in errors.ts; the route layer (Epic 2) maps it to
 * 404 Not Found.
 */
export class WorkItemLinkNotFoundError extends WorkItemLinkError {
  readonly tag = 'WORK_ITEM_LINK_NOT_FOUND' as const;
  readonly code = 'WORK_ITEM_LINK_NOT_FOUND' as const;
  constructor(id: string) {
    super(`Work item link ${id} not found.`);
    this.name = 'WorkItemLinkNotFoundError';
  }
}
