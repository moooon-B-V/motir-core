// Typed errors for the work-item to-do domain (Story MOTIR-3808 · MOTIR-3813).
// Kept in their own file so callers — Server Actions, route handlers, Server
// Components — can import them without pulling in the Prisma client, the
// `lib/comments/errors.ts` precedent.
//
// Per CLAUDE.md the service throws these and the caller translates the stable
// `code`:
//   WorkItemTodoNotFoundError  → 404 (a cross-workspace or invisible to-do id is
//                                     indistinguishable from a never-existed one
//                                     — finding #44, no existence leak)
//   TodoTextTooLongError       → 422 (the granularity bar; the text is REJECTED,
//                                     never silently truncated)
//   TodoCommandTooLongError    → 422
//   EmptyTodoTextError         → 422
//   TodoReorderConflictError   → 409 (a concurrent reorder moved or removed a
//                                     neighbour out from under this one)
//
// There is deliberately no `TodoForbiddenError`: every write on a to-do is
// gated by `work_item:edit` on the parent card (ADR §4), so the refusal is the
// work item's own `ProjectAccessDeniedError('edit')` and adding a second name
// for it would put two vocabularies on one permission.

import { TODO_COMMAND_MAX_LENGTH, TODO_TEXT_MAX_LENGTH } from './limits';

export class WorkItemTodoNotFoundError extends Error {
  readonly code = 'WORK_ITEM_TODO_NOT_FOUND' as const;
  constructor(todoId: string) {
    super(`To-do ${todoId} not found.`);
    this.name = 'WorkItemTodoNotFoundError';
  }
}

export class EmptyTodoTextError extends Error {
  readonly code = 'EMPTY_TODO_TEXT' as const;
  constructor() {
    super('A to-do must say what to do.');
    this.name = 'EmptyTodoTextError';
  }
}

export class TodoTextTooLongError extends Error {
  readonly code = 'TODO_TEXT_TOO_LONG' as const;
  readonly limit = TODO_TEXT_MAX_LENGTH;
  readonly actual: number;
  constructor(actual: number) {
    // The message names the bar AND why it exists — a user who hits it is
    // being told to split a step, not to write more tersely.
    super(
      `A to-do is one operation, so its text is capped at ${TODO_TEXT_MAX_LENGTH} characters (this one is ${actual}). Split it into two steps.`,
    );
    this.name = 'TodoTextTooLongError';
    this.actual = actual;
  }
}

export class TodoCommandTooLongError extends Error {
  readonly code = 'TODO_COMMAND_TOO_LONG' as const;
  readonly limit = TODO_COMMAND_MAX_LENGTH;
  readonly actual: number;
  constructor(actual: number) {
    super(
      `A to-do's command is capped at ${TODO_COMMAND_MAX_LENGTH} characters (this one is ${actual}).`,
    );
    this.name = 'TodoCommandTooLongError';
    this.actual = actual;
  }
}

export class TodoReorderConflictError extends Error {
  readonly code = 'TODO_REORDER_CONFLICT' as const;
  constructor() {
    super('The list changed while this step was being moved. Reload and try again.');
    this.name = 'TodoReorderConflictError';
  }
}
