// Typed errors for the activity domain (Story 5.5 · Subtask 5.5.2). Kept in
// their own file so route handlers can import them without pulling in the
// Prisma client (the lib/<domain>/errors.ts convention).
//
// Per CLAUDE.md, the service throws these and the route layer translates the
// stable `code` to an HTTP status:
//   InvalidActivityCursorError → 400 (a malformed / hand-edited composite
//                                     cursor on the All stream — the opaque
//                                     token failed to decode or carried the
//                                     wrong shape)

export class InvalidActivityCursorError extends Error {
  readonly code = 'INVALID_ACTIVITY_CURSOR' as const;
  constructor() {
    super('The activity cursor is malformed.');
    this.name = 'InvalidActivityCursorError';
  }
}
