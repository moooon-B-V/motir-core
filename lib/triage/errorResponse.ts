import { NextResponse } from 'next/server';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  WorkItemNotFoundError,
  CrossProjectParentError,
  IllegalParentTypeError,
  DepthLimitExceededError,
  ParentCycleError,
} from '@/lib/workItems/errors';
import { SprintNotFoundError, CrossProjectSprintAssignmentError } from '@/lib/sprints/errors';
import {
  NotInTriageError,
  TriageSelfMergeError,
  InvalidSnoozeUntilError,
} from '@/lib/triage/errors';

// Shared typed-error → HTTP-status translation for the triage-ACTION routes
// (Story 6.11 · Subtask 6.11.5) — keeps the five thin route files from
// duplicating the same branches (the customFieldErrorResponse pattern). Returns
// a NextResponse for a known domain error, or null so the route rethrows (a
// genuine 500).
//
//   WorkItemNotFoundError / SprintNotFoundError /
//     ProjectNotFoundError /
//     ProjectAccessDeniedError(kind: browse)              → 404 (no existence
//       leak — a cross-workspace / hidden id is indistinguishable from a
//       never-existed one, findings #26/#44)
//   ProjectAccessDeniedError(kind: edit)                  → 403 (read-only)
//   NotInTriageError                                      → 409 (already
//       graduated — a state conflict, not a missing item)
//   IllegalParentTypeError / DepthLimitExceededError /
//     ParentCycleError / CrossProjectParentError /
//     CrossProjectSprintAssignmentError / TriageSelfMergeError /
//     InvalidSnoozeUntilError                             → 422 (a semantically
//       invalid argument for an otherwise-valid item)
export function triageActionErrorResponse(err: unknown): NextResponse | null {
  if (
    err instanceof WorkItemNotFoundError ||
    err instanceof SprintNotFoundError ||
    err instanceof ProjectNotFoundError ||
    (err instanceof ProjectAccessDeniedError && err.kind === 'browse')
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
  }
  if (err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (err instanceof NotInTriageError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
  }
  if (
    err instanceof IllegalParentTypeError ||
    err instanceof DepthLimitExceededError ||
    err instanceof ParentCycleError ||
    err instanceof CrossProjectParentError ||
    err instanceof CrossProjectSprintAssignmentError ||
    err instanceof TriageSelfMergeError ||
    err instanceof InvalidSnoozeUntilError
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
  }
  return null;
}
