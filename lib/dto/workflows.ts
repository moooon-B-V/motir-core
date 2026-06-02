// DTOs for the per-project status-workflow surface (Story 2.2 · Subtask 2.2.3).
// What `workflowsService` returns to its callers (board columns, status
// pickers, the transition validator) — never the raw Prisma `WorkflowStatus` /
// `WorkflowTransition` models. Enums cross the boundary as string-literal
// unions (the `WorkItemPriorityDto` / `JobRunStatus` convention), so a consumer
// never imports `@prisma/client`.

/** The frozen Jira three-bucket taxonomy every status falls into. */
export type StatusCategoryDto = 'todo' | 'in_progress' | 'done';

/** Per-project transition-enforcement mode. */
export type WorkflowPolicyModeDto = 'restricted' | 'open';

/** One per-project status. `position` is the opaque fractional-index sort key. */
export interface WorkflowStatusDto {
  id: string;
  projectId: string;
  key: string;
  label: string;
  category: StatusCategoryDto;
  /** Per-status hex override, or null to derive the swatch from `category`. */
  color: string | null;
  position: string;
  isInitial: boolean;
}

/** One legal directed status move within a project. */
export interface WorkflowTransitionDto {
  id: string;
  projectId: string;
  fromStatusId: string;
  toStatusId: string;
}

/**
 * A project's full workflow: its statuses (ordered by `position`), its legal
 * transitions, and its policy mode. The shape board / settings surfaces read.
 */
export interface WorkflowDto {
  statuses: WorkflowStatusDto[];
  transitions: WorkflowTransitionDto[];
  policyMode: WorkflowPolicyModeDto;
}
