import { describe, expect, it } from 'vitest';
import type { DashboardWidgetDto } from '@/lib/dto/dashboards';
import {
  columnCount,
  computeWidgetMove,
  reflowToLayout,
  widgetsByColumn,
  widgetsInColumn,
} from '@/app/(authed)/dashboard/_components/gridModel';

// Pure grid-state helpers for the dashboard grid (Subtask 6.3.5) — the
// optimistic move + the layout-shrink reflow, tested without mounting the dnd
// component (the 3.2 `computeColumnReorder` precedent). The server re-mints the
// fractional position authoritatively; these assert the OPTIMISTIC placement +
// the neighbour ids the move endpoint receives.

function w(
  id: string,
  column: number,
  position: string,
  type: DashboardWidgetDto['type'] = 'distribution',
): DashboardWidgetDto {
  return {
    id,
    type,
    column,
    position,
    config: { statisticType: 'status' },
    source: { kind: 'project', projectId: 'p1', name: 'Motir' },
    rendererKind: 'donut',
    editorKind: 'distribution_editor',
  };
}

describe('columnCount', () => {
  it('maps the layout enum to its column count', () => {
    expect(columnCount('one')).toBe(1);
    expect(columnCount('two')).toBe(2);
    expect(columnCount('three')).toBe(3);
  });
});

describe('widgetsInColumn / widgetsByColumn', () => {
  it('returns a column ascending by fractional position', () => {
    const ws = [w('c', 0, 'a2'), w('a', 0, 'a0'), w('b', 0, 'a1')];
    expect(widgetsInColumn(ws, 0).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('buckets widgets per column and clamps an orphan into the last column', () => {
    const ws = [w('a', 0, 'a0'), w('b', 1, 'a0'), w('orphan', 5, 'a0')];
    const cols = widgetsByColumn(ws, 2);
    expect(cols).toHaveLength(2);
    expect(cols[0]!.map((x) => x.id)).toEqual(['a']);
    expect(cols[1]!.map((x) => x.id).sort()).toEqual(['b', 'orphan']);
  });
});

describe('computeWidgetMove', () => {
  const ws = [w('a', 0, 'a0'), w('b', 0, 'a1'), w('c', 1, 'a0')];

  it('moves a widget to the end of another column (appended, beforeId null)', () => {
    const plan = computeWidgetMove(ws, 'a', 1, null);
    expect(plan).not.toBeNull();
    expect(plan!.column).toBe(1);
    expect(plan!.afterId).toBe('c');
    expect(plan!.beforeId).toBeNull();
    // The optimistic list places a after c in column 1.
    expect(widgetsInColumn(plan!.widgets, 1).map((x) => x.id)).toEqual(['c', 'a']);
    expect(widgetsInColumn(plan!.widgets, 0).map((x) => x.id)).toEqual(['b']);
  });

  it('inserts BEFORE the over-widget, computing both neighbours', () => {
    const plan = computeWidgetMove(ws, 'c', 0, 'b');
    expect(plan!.column).toBe(0);
    expect(plan!.afterId).toBe('a');
    expect(plan!.beforeId).toBe('b');
    expect(widgetsInColumn(plan!.widgets, 0).map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('returns null for a drop on itself', () => {
    expect(computeWidgetMove(ws, 'a', 0, 'a')).toBeNull();
  });

  it('returns null for an unknown active id', () => {
    expect(computeWidgetMove(ws, 'zzz', 0, null)).toBeNull();
  });

  it('produces a position strictly between the neighbours', () => {
    const plan = computeWidgetMove(ws, 'c', 0, 'b');
    expect(plan!.position > 'a0').toBe(true);
    expect(plan!.position < 'a1').toBe(true);
  });
});

describe('reflowToLayout', () => {
  it('rehomes orphaned columns into the new last column, preserving order', () => {
    const ws = [w('a', 0, 'a0'), w('b', 1, 'a0'), w('c', 2, 'a0'), w('d', 2, 'a1')];
    const reflowed = reflowToLayout(ws, 2);
    // c, d were in column 2 → now appended to column 1 after b, in order.
    expect(widgetsInColumn(reflowed, 1).map((x) => x.id)).toEqual(['b', 'c', 'd']);
    expect(reflowed.every((x) => x.column < 2)).toBe(true);
  });

  it('is a no-op when no column is orphaned', () => {
    const ws = [w('a', 0, 'a0'), w('b', 1, 'a0')];
    expect(reflowToLayout(ws, 3)).toBe(ws);
  });
});
