// Typed errors for the cross-origin idea-draft handoff (Subtask 7.22.2 /
// MOTIR-1458). The route layer translates each to an HTTP status; the service
// throws them so a raw Prisma/validation failure never escapes the boundary.

/** The submitted idea was empty (or whitespace-only) after trimming. → 400 */
export class EmptyIdeaError extends Error {
  readonly code = 'EMPTY_IDEA';
  constructor() {
    super('The idea is empty.');
    this.name = 'EmptyIdeaError';
  }
}

/**
 * The `draftId` did not resolve to a live draft — it was never issued, was
 * already claimed (single-use), or has expired past its TTL. Deliberately does
 * NOT distinguish these cases: a claimer learns only "no draft", never whether
 * an id ever existed (no probing oracle). The claim route maps it to 404 and the
 * caller degrades to a normal login (no crash, no leak). → 404
 */
export class DraftNotFoundError extends Error {
  readonly code = 'DRAFT_NOT_FOUND';
  constructor() {
    super('The idea draft was not found or has expired.');
    this.name = 'DraftNotFoundError';
  }
}
