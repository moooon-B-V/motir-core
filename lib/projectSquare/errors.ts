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

/**
 * A client supplied an unrecognised `rank` query param to the directory read —
 * one outside the `trending | popular | recent` set (Subtask 6.13.4). The route
 * maps this to 400 (Bad Request). An absent `rank` is NOT an error — it falls
 * back to the default rank; this fires only on a present-but-invalid value.
 */
export class InvalidProjectSquareRankError extends Error {
  readonly code = 'INVALID_RANK' as const;
  constructor() {
    super('Invalid project-square rank.');
    this.name = 'InvalidProjectSquareRankError';
  }
}

/**
 * A client supplied an unrecognised `window` query param — one outside the
 * `day | week | month` Trending recency set (Subtask 6.13.4). The route maps
 * this to 400. An absent `window` falls back to the default; this fires only on
 * a present-but-invalid value. (Only the `trending` rank reads `window`; it is
 * ignored for popular/recent.)
 */
export class InvalidProjectSquareWindowError extends Error {
  readonly code = 'INVALID_WINDOW' as const;
  constructor() {
    super('Invalid project-square trending window.');
    this.name = 'InvalidProjectSquareWindowError';
  }
}
