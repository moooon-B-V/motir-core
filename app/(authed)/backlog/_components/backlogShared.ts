import type { RankedIssuePageDto } from '@/lib/dto/backlog';
import type { SprintDto, SprintStateDto } from '@/lib/dto/sprints';
import type { StatusCategoryDto, WorkflowStatusDto } from '@/lib/dto/workflows';
import type { PillProps } from '@/components/ui/Pill';

// Shared types + pure helpers for the Backlog surface (Story 4.2 · Subtask
// 4.2.3). No JSX, no hooks — a leaf module so the container, the list, the
// sprint container, and the row all read the SAME status/assignee resolution
// and sprint-state mapping. The page binds to the bounded reads Story 4.1.4
// shipped (`getBacklog` / `getSprintIssues`) + the 4.2.3 sprint-list read; this
// module only RESOLVES their wire shapes for display.

/** Wire shape of `GET /api/sprints` — the active project's sprints + counts. */
export interface SprintListResponse {
  sprints: SprintDto[];
}

/** Wire shape of `GET /api/backlog` and `GET /api/sprints/[id]/issues`. */
export type RankedIssuePage = RankedIssuePageDto;

/** A status key → its display label + lifecycle category, for the row `Pill`. */
export type StatusByKey = Map<string, { label: string; category: StatusCategoryDto }>;

/** Build the status lookup the rows resolve their `Pill` tone/label from. */
export function buildStatusByKey(statuses: WorkflowStatusDto[]): StatusByKey {
  return new Map(statuses.map((s) => [s.key, { label: s.label, category: s.category }]));
}

/** Build the assignee id → display name lookup (mirrors the board's). */
export function buildAssigneeNameById(
  members: { userId: string; name: string; email: string }[],
): Map<string, string> {
  return new Map(members.map((m) => [m.userId, m.name || m.email]));
}

/**
 * A sprint's `state` → the shipped `Pill` status tone — the SAME AA-safe tones
 * the rest of the app uses (planned → lavender, active → sky, complete → mint),
 * per the 4.2.1 design notes. Reuses the `Pill` vocabulary, never a new chip.
 */
export const SPRINT_STATE_TONE: Record<SprintStateDto, NonNullable<PillProps['status']>> = {
  planned: 'planned',
  active: 'in-progress',
  complete: 'done',
};

/**
 * The planning view shows the ACTIVE sprint + future PLANNED sprints over the
 * backlog — NOT the long tail of completed sprints (mirror rung 1: Jira's
 * backlog screen excludes completed sprints; they live in reports). Active
 * first, then planned by `sequence`.
 */
export function planningSprints(sprints: SprintDto[]): SprintDto[] {
  return sprints
    .filter((s) => s.state !== 'complete')
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === 'active' ? -1 : 1;
      return a.sequence - b.sequence;
    });
}
