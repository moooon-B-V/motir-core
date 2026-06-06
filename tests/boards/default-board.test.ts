import { describe, expect, it } from 'vitest';
import { buildDefaultBoard, DEFAULT_BOARD_NAME } from '@/lib/boards/defaultBoard';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

// Pure-builder unit tests for the default-board spec (Story 3.1 · Subtask
// 3.1.2). No DB — buildDefaultBoard is a pure function of its input, exactly
// like the defaultWorkflow constant. The snapshot pins the six-column default
// projected from the six default statuses (2.2.2).

// The six default statuses as the DTOs the service feeds buildDefaultBoard —
// derived from the SAME DEFAULT_STATUSES constant createProject seeds, with
// synthetic stable ids so the snapshot is deterministic.
const defaultStatusDtos: WorkflowStatusDto[] = DEFAULT_STATUSES.map((s, i) => ({
  id: `status-${i}`,
  projectId: 'project-1',
  key: s.key,
  label: s.label,
  category: s.category,
  color: null,
  position: s.position,
  isInitial: s.isInitial,
}));

describe('buildDefaultBoard', () => {
  it('projects one Kanban board named "Board" with one column per status', () => {
    const spec = buildDefaultBoard(defaultStatusDtos);
    expect(spec.name).toBe(DEFAULT_BOARD_NAME);
    expect(spec.type).toBe('kanban');
    expect(spec.columns).toHaveLength(defaultStatusDtos.length);
  });

  it('column name + position mirror the status; each column maps its single status key', () => {
    const spec = buildDefaultBoard(defaultStatusDtos);
    expect(spec.columns.map((c) => c.name)).toEqual([
      'To Do',
      'Blocked',
      'In Progress',
      'In Review',
      'Done',
      'Cancelled',
    ]);
    // statusKeys are the workflow keys in display order, one per column (1:1).
    expect(spec.columns.map((c) => c.statusKeys)).toEqual([
      ['todo'],
      ['blocked'],
      ['in_progress'],
      ['in_review'],
      ['done'],
      ['cancelled'],
    ]);
    // Column positions mirror the source statuses' positions verbatim.
    expect(spec.columns.map((c) => c.position)).toEqual(defaultStatusDtos.map((s) => s.position));
  });

  it('orders columns by status.position regardless of input order (defensive sort)', () => {
    const shuffled = [
      defaultStatusDtos[4]!, // done
      defaultStatusDtos[0]!, // todo
      defaultStatusDtos[2]!, // in_progress
      defaultStatusDtos[5]!, // cancelled
      defaultStatusDtos[1]!, // blocked
      defaultStatusDtos[3]!, // in_review
    ];
    const spec = buildDefaultBoard(shuffled);
    expect(spec.columns.map((c) => c.statusKeys[0])).toEqual([
      'todo',
      'blocked',
      'in_progress',
      'in_review',
      'done',
      'cancelled',
    ]);
  });

  it('is pure — does not mutate the input array', () => {
    const input = [...defaultStatusDtos];
    const snapshot = input.map((s) => s.key);
    buildDefaultBoard(input);
    expect(input.map((s) => s.key)).toEqual(snapshot);
  });

  it('matches the canonical six-column default (snapshot)', () => {
    // Snapshot the meaningful projection — name, type, and each column's label
    // + mapped keys. The opaque fractional-index `position` is an
    // implementation detail of the workflow seed (asserted to mirror the status
    // verbatim above), so it's normalized out to keep the snapshot stable
    // across position-encoding changes.
    const spec = buildDefaultBoard(defaultStatusDtos);
    const normalized = {
      name: spec.name,
      type: spec.type,
      columns: spec.columns.map((c) => ({ name: c.name, statusKeys: c.statusKeys })),
    };
    expect(normalized).toMatchInlineSnapshot(`
      {
        "columns": [
          {
            "name": "To Do",
            "statusKeys": [
              "todo",
            ],
          },
          {
            "name": "Blocked",
            "statusKeys": [
              "blocked",
            ],
          },
          {
            "name": "In Progress",
            "statusKeys": [
              "in_progress",
            ],
          },
          {
            "name": "In Review",
            "statusKeys": [
              "in_review",
            ],
          },
          {
            "name": "Done",
            "statusKeys": [
              "done",
            ],
          },
          {
            "name": "Cancelled",
            "statusKeys": [
              "cancelled",
            ],
          },
        ],
        "name": "Board",
        "type": "kanban",
      }
    `);
  });
});
