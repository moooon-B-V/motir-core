import type { BoardType } from '@prisma/client';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

// The v1 default per-project board (Story 3.1 · Subtask 3.1.2) — the typed,
// pure spec `boardsService.seedDefaultBoard` writes into every new project
// alongside the default workflow (2.2.2). It is the column-from-workflow
// PROJECTION: one Kanban board whose columns are the project's workflow
// statuses, in `status.position` order, each column mapped to its single
// status.
//
// IMPORTANT — this is a seeded DEFAULT *over* the durable many-to-one mapping
// (3.1.1's `board_column_status`), NOT a hardcoded one-column-per-status shape.
// The schema lets many statuses map to one column (the Jira "merge In Progress
// + In Review" shape) and lets a status be unmapped; the default just happens
// to start 1:1. That is why a column owns a `statusKeys` SET, not a single
// `statusKey` — the spec mirrors the mapping table's shape so an admin merge/
// split later is a data change, not a schema change (the no-shortcuts rule).
//
// Pure / typed / no I/O — snapshot-testable in isolation, exactly like
// `lib/workflows/defaultWorkflow.ts`. It references statuses by their stable
// `key` (not the generated row id) so the spec is deterministic and snapshot-
// stable; the service resolves `key → status.id` when it persists the mappings.

/** One default-board column: its display meta + the status key(s) it maps. */
export interface DefaultBoardColumnSpec {
  /** Column label — mirrors the source status's label. */
  name: string;
  /** Fractional-index sort key — mirrors the source status's `position`. */
  position: string;
  /**
   * The workflow-status `key`(s) this column maps. The default seeds exactly
   * one per column (1:1), but the field is a SET so the shape matches the
   * durable `board_column_status` mapping (many statuses MAY share a column).
   */
  statusKeys: string[];
}

/** The full default-board spec: a Kanban board + its ordered columns. */
export interface DefaultBoardSpec {
  name: string;
  type: BoardType;
  columns: DefaultBoardColumnSpec[];
}

/** The v1 default board's name (Jira-style single board per project). */
export const DEFAULT_BOARD_NAME = 'Board';

/**
 * Build the default-board spec from a project's workflow statuses — one
 * Kanban board, one column per status in `status.position` order, each column
 * mapped to its single status. Pure: deterministic in the input, no I/O.
 *
 * The input is defensively sorted by `position` (the same opaque fractional-
 * index String the work-item / workflow-status columns use, so lexical order
 * IS display order) rather than trusting the caller's order — the spec's
 * column order is the workflow's display order regardless of how the statuses
 * arrive.
 */
export function buildDefaultBoard(statuses: WorkflowStatusDto[]): DefaultBoardSpec {
  const columns = [...statuses]
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    .map(
      (status): DefaultBoardColumnSpec => ({
        name: status.label,
        position: status.position,
        statusKeys: [status.key],
      }),
    );

  return { name: DEFAULT_BOARD_NAME, type: 'kanban', columns };
}
