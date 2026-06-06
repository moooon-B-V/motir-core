// Typed errors for the board domain (Story 3.1). Kept in their own file so
// callers — the service layer, and the 3.1.6 route handlers — can import them
// without pulling in the Prisma client. Each carries a stable string `code`
// the route layer maps to an HTTP status, matching the `readonly code`
// convention the workflows / projects / workspaces domains established.
//
// The board MOVE path (Subtask 3.1.5) is the first consumer:
//   - IllegalBoardMoveError    → 409 (the snapback signal the 3.2 UI branches on)
//   - UnmappedColumnTargetError → 422 (a column that maps no status)
//   - BoardNotFoundError / BoardColumnNotFoundError → 404
// A not-found WORK ITEM (the moved card or a rank neighbor) reuses the existing
// `WorkItemNotFoundError` from `lib/workItems/errors.ts` (already a 404), so the
// move path doesn't invent a parallel work-item-not-found error.

/**
 * A cross-column move resolved to an ILLEGAL workflow transition under the
 * project's `restricted` policy (no `workflow_transition` row connects the
 * pair). The board move is rejected and the issue's status + rank are left
 * unchanged — the contract the 3.2 UI relies on to **snap the card back**.
 * Re-raised from the underlying `IllegalTransitionError` so the board layer
 * exposes ONE board-shaped error (carrying the from/to status + the reason)
 * rather than leaking the work-item transition error. → 409.
 */
export class IllegalBoardMoveError extends Error {
  readonly code = 'ILLEGAL_BOARD_MOVE' as const;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly reason: string;
  constructor(fromStatus: string, toStatus: string, reason = 'Illegal board move.') {
    super(`Illegal board move: "${fromStatus}" → "${toStatus}" (${reason}).`);
    this.name = 'IllegalBoardMoveError';
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
    this.reason = reason;
  }
}

/**
 * The drop target column maps NO workflow status (or maps only statuses that no
 * longer exist in the project's workflow), so the move has no status to resolve
 * to. Distinct from an illegal transition: there is simply nothing to move the
 * card INTO. → 422.
 */
export class UnmappedColumnTargetError extends Error {
  readonly code = 'UNMAPPED_COLUMN_TARGET' as const;
  readonly columnId: string;
  constructor(columnId: string) {
    super(`Board column ${columnId} maps no workflow status — nothing to move the card into.`);
    this.name = 'UnmappedColumnTargetError';
    this.columnId = columnId;
  }
}

/** No board matched the id in the active workspace. → 404. */
export class BoardNotFoundError extends Error {
  readonly code = 'BOARD_NOT_FOUND' as const;
  readonly boardId: string;
  constructor(boardId: string) {
    super(`Board ${boardId} not found.`);
    this.name = 'BoardNotFoundError';
    this.boardId = boardId;
  }
}

/**
 * No column matched the id on the target board in the active workspace (the
 * column doesn't exist, belongs to another board, or to another workspace).
 * → 404.
 */
export class BoardColumnNotFoundError extends Error {
  readonly code = 'BOARD_COLUMN_NOT_FOUND' as const;
  readonly columnId: string;
  constructor(columnId: string) {
    super(`Board column ${columnId} not found.`);
    this.name = 'BoardColumnNotFoundError';
    this.columnId = columnId;
  }
}
