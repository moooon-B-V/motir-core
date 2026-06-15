// Typed errors for the PROJECT SQUARE directory (Story 6.13). Kept in their own
// file so callers — route handlers, server components — can import them without
// pulling in the Prisma client. Per CLAUDE.md, services throw typed errors with
// stable string `code`s; the route layer translates them to HTTP status codes.

/**
 * A client supplied a malformed `cursor` query param to the directory read —
 * one that does not decode to a valid `(createdAt, id)` keyset position. The
 * route maps this to 400 (Bad Request). A well-formed first-page request omits
 * the cursor entirely; a valid `nextCursor` is only ever produced by the
 * service, so this fires on a hand-tampered / truncated value.
 */
export class InvalidProjectSquareCursorError extends Error {
  readonly code = 'INVALID_CURSOR' as const;
  constructor() {
    super('Invalid project-square pagination cursor.');
    this.name = 'InvalidProjectSquareCursorError';
  }
}
