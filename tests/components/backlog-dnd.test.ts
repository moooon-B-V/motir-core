import { describe, expect, it } from 'vitest';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import {
  BACKLOG_REGION_ID,
  arrayInsertAt,
  arrayRelocate,
  arrayRemove,
  planBacklogMove,
  resolveInsertion,
  sprintRegionId,
  writeForPlan,
  type RegionRef,
} from '@/app/(authed)/backlog/_components/backlogDnd';

// Pure backlog-drag resolution (Subtask 4.2.4) — the side-effect-free core the
// dnd-kit coordinator drives. Proves the three moves resolve to the right
// Story-4.1.4 write + the right optimistic relocation, and that the array
// helpers (apply / snap-back) are exact, WITHOUT a real pointer drag (the real
// drag is the 4.2.6 Playwright E2E). Mirrors tests/components/board-move.test.ts.

function item(key: number, over: Partial<WorkItemSummaryDto> = {}): WorkItemSummaryDto {
  return {
    id: `i${key}`,
    parentId: null,
    kind: 'task',
    identifier: `PROD-${key}`,
    title: `Item ${key}`,
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    archivedAt: null,
    ...over,
  } as WorkItemSummaryDto;
}

const backlog: RegionRef = { id: BACKLOG_REGION_ID, kind: 'backlog' };
const sprintA: RegionRef = { id: sprintRegionId('sA'), kind: 'sprint', sprintId: 'sA' };
const sprintB: RegionRef = { id: sprintRegionId('sB'), kind: 'sprint', sprintId: 'sB' };

describe('resolveInsertion', () => {
  const rows = [item(1), item(2), item(3)];

  it('drops BEFORE the hovered row (excluding the active row)', () => {
    // Dragging i1 over i3 → lands before i3, between i2 and i3.
    const r = resolveInsertion(rows, 'i1', 'i3', false);
    expect(r.insertAt).toBe(1); // in the without-active list [i2, i3], index of i3 is 1
    expect(r.beforeId).toBe('i2');
    expect(r.afterId).toBe('i3');
  });

  it('drops at the END when over the region body', () => {
    const r = resolveInsertion(rows, 'i1', BACKLOG_REGION_ID, true);
    expect(r.insertAt).toBe(2); // [i2, i3].length
    expect(r.beforeId).toBe('i3');
    expect(r.afterId).toBeUndefined();
  });

  it('prepends when over the first row', () => {
    const r = resolveInsertion(rows, 'i3', 'i1', false);
    expect(r.insertAt).toBe(0);
    expect(r.beforeId).toBeUndefined();
    expect(r.afterId).toBe('i1');
  });
});

describe('planBacklogMove', () => {
  const rows = [item(1), item(2), item(3)];

  it('reorders within a region (same source/target) → rank write', () => {
    const plan = planBacklogMove({
      source: backlog,
      target: backlog,
      activeId: 'i3',
      targetItems: rows,
      sourceIndex: 2,
      overId: 'i1',
      overIsRegion: false,
    });
    expect(plan.kind).toBe('reorder');
    expect(writeForPlan(plan)).toEqual({
      url: '/api/work-items/i3/rank',
      body: { beforeId: undefined, afterId: 'i1' },
    });
  });

  it('is a NO-OP when the row lands back in its own slot', () => {
    // i2 dragged over i3 → before i3 → index 1 in [i1, i3] === its own index → none.
    const plan = planBacklogMove({
      source: backlog,
      target: backlog,
      activeId: 'i2',
      targetItems: rows,
      sourceIndex: 1,
      overId: 'i3',
      overIsRegion: false,
    });
    expect(plan.kind).toBe('none');
  });

  it('assigns backlog → sprint with the drop placement', () => {
    const sprintRows = [item(10), item(11)];
    const plan = planBacklogMove({
      source: backlog,
      target: sprintA,
      activeId: 'i1',
      targetItems: sprintRows,
      sourceIndex: 0,
      overId: 'i11',
      overIsRegion: false,
    });
    expect(plan.kind).toBe('assign');
    expect(writeForPlan(plan)).toEqual({
      url: '/api/work-items/i1/sprint',
      body: { sprintId: 'sA', beforeId: 'i10', afterId: 'i11' },
    });
  });

  it('assigns sprint → sprint (cross-sprint) with the target sprint id', () => {
    const plan = planBacklogMove({
      source: sprintA,
      target: sprintB,
      activeId: 'i1',
      targetItems: [],
      sourceIndex: 0,
      overId: sprintRegionId('sB'),
      overIsRegion: true,
    });
    expect(plan.kind).toBe('assign');
    expect(writeForPlan(plan).body).toEqual({
      sprintId: 'sB',
      beforeId: undefined,
      afterId: undefined,
    });
  });

  it('moves sprint → backlog (no placement — rank preserved)', () => {
    const plan = planBacklogMove({
      source: sprintA,
      target: backlog,
      activeId: 'i1',
      targetItems: [item(2)],
      sourceIndex: 0,
      overId: 'i2',
      overIsRegion: false,
    });
    expect(plan.kind).toBe('to-backlog');
    expect(writeForPlan(plan)).toEqual({
      url: '/api/work-items/i1/sprint',
      body: { sprintId: null },
    });
  });

  it('throws if a no-op plan is sent to writeForPlan', () => {
    const plan = planBacklogMove({
      source: backlog,
      target: backlog,
      activeId: 'i2',
      targetItems: rows,
      sourceIndex: 1,
      overId: 'i3',
      overIsRegion: false,
    });
    expect(() => writeForPlan(plan)).toThrow();
  });
});

describe('array helpers (optimistic apply + snap-back)', () => {
  const rows = [item(1), item(2), item(3)];

  it('arrayRelocate moves a row to the target slot', () => {
    expect(arrayRelocate(rows, 'i3', 0).map((r) => r.id)).toEqual(['i3', 'i1', 'i2']);
    expect(arrayRelocate(rows, 'i1', 2).map((r) => r.id)).toEqual(['i2', 'i3', 'i1']);
  });

  it('arrayRemove + arrayInsertAt are exact inverses of a cross-region move', () => {
    const src = rows;
    const tgt = [item(10), item(11)];
    const moved = src[0]!;
    const newSrc = arrayRemove(src, 'i1');
    const newTgt = arrayInsertAt(tgt, moved, 1);
    expect(newSrc.map((r) => r.id)).toEqual(['i2', 'i3']);
    expect(newTgt.map((r) => r.id)).toEqual(['i10', 'i1', 'i11']);
    // Snap-back restores the originals (the coordinator setItems(snapshot)).
    expect(src.map((r) => r.id)).toEqual(['i1', 'i2', 'i3']);
    expect(tgt.map((r) => r.id)).toEqual(['i10', 'i11']);
  });

  it('arrayRelocate / arrayRemove are no-ops for an absent id', () => {
    expect(arrayRelocate(rows, 'nope', 0)).toBe(rows);
    expect(arrayRemove(rows, 'nope').map((r) => r.id)).toEqual(['i1', 'i2', 'i3']);
  });
});
