import { z } from 'zod';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkItemDto } from '@/lib/dto/workItems';

// Shared sprint-tool plumbing (Story 7.8 · Subtask 7.8.10). The eight sprint
// tools all address a project by its key (`list_sprints` / `create_sprint`) or
// a sprint by its id (`update`/`delete`/`start`/`complete`/`move_to_sprint`),
// and summarise a `SprintDto` / the moved-issue set into the dual-content text
// block. Kept in one place so the tools can't drift on what a key/id means or
// how a sprint reads back. The sprint TOOLS hold no business logic — every
// guard (owner gate, state machine, same-project) lives in `sprintsService` /
// `backlogService`; this module is pure presentation + shared zod fields.

/** The zod field every project-scoped sprint tool shares. */
export const projectKeyField = z
  .string()
  .min(1)
  .describe('The project key the sprint belongs to, e.g. "PROD".');

/**
 * The zod field every sprint-addressed tool shares. A sprint is addressed by
 * its opaque id (NOT a `PROD-<n>` work-item key) — obtain it from
 * `list_sprints`, which returns each sprint's `id` alongside its name/state.
 */
export const sprintIdField = z
  .string()
  .min(1)
  .describe('The sprint id (as returned by `list_sprints`).');

/**
 * The shared finishability-strictness field for the validation tools
 * (`validate_sprint`, `validate_work_item`; Subtask 7.8.22). Defaults to
 * `loose` so omitting it preserves the original behaviour — a `done` gating
 * item outside the containing set counts as satisfied. `tight` requires every
 * gating item to be IN the set (a `done` item outside it is reported instead).
 */
export const conditionField = z
  .enum(['loose', 'tight'])
  .optional()
  .default('loose')
  .describe(
    'How strict to be about a DONE gating item that sits OUTSIDE the set ' +
      '(sprint / subtree). `loose` (default): a done item outside the set counts ' +
      'as satisfied. `tight`: only an in-set item satisfies — a done item outside ' +
      'the set is reported as a blocker.',
  );

/** Compact human-readable summary of a sprint for the dual-content text block. */
export function summarizeSprint(dto: SprintDto): string {
  const parts = [`Sprint "${dto.name}" (${dto.id})`, dto.state, `${dto.issueCount} issue(s)`];
  if (dto.goal) parts.push(`goal: ${dto.goal}`);
  if (dto.startDate || dto.endDate) {
    parts.push(`window: ${dto.startDate ?? '—'} → ${dto.endDate ?? '—'}`);
  }
  if (dto.completedAt) parts.push(`completed: ${dto.completedAt}`);
  return parts.join(' · ');
}

/** One-line summary of a bulk sprint↔backlog move for the text block. */
export function summarizeMovedItems(items: WorkItemDto[], destination: string): string {
  if (items.length === 0) return `No items moved (empty selection).`;
  const keys = items.map((i) => i.identifier).join(', ');
  return `Moved ${items.length} item(s) to ${destination}: ${keys}`;
}
