// Typed errors for the operator-dashboard surface of the background-jobs
// runtime (Story 1.6 · Subtask 1.6.5). The Server Action layer translates
// these into UI results (toast copy); they keep the service from leaking raw
// Error strings to the transport.

/**
 * Thrown when a non-owner attempts to replay a dead-lettered job. Replay is
 * gated to the workspace `owner` role (lib/workspaces/roles.ts); members get a
 * disabled button in the UI, but the service re-checks server-side so the gate
 * can't be bypassed by posting the action directly.
 */
export class ReplayForbiddenError extends Error {
  readonly code = 'REPLAY_FORBIDDEN' as const;
  constructor(userId: string, workspaceId: string) {
    super(`User ${userId} is not an owner of workspace ${workspaceId} and cannot replay jobs`);
    this.name = 'ReplayForbiddenError';
  }
}

/**
 * Thrown when a replay targets a DLQ id that isn't in the caller's workspace
 * (unknown id, or another workspace's row hidden by RLS). Surfaces as a
 * not-found to the UI — never confirms a cross-workspace id exists.
 */
export class DlqEntryNotFoundError extends Error {
  readonly code = 'DLQ_NOT_FOUND' as const;
  constructor(dlqId: string) {
    super(`job_run_dlq ${dlqId} not found in the active workspace`);
    this.name = 'DlqEntryNotFoundError';
  }
}
