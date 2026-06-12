import type { DashboardLayout } from '@prisma/client';
import { LAYOUT_COLUMN_COUNT } from '@/lib/dashboards/constants';
import { keyBetween, keyForAppend } from '@/lib/workItems/positioning';
import type { DashboardWidgetDto } from '@/lib/dto/dashboards';

// Pure grid-state helpers for the dashboard grid (6.3.5) — extracted so the
// optimistic move + the layout reflow are unit-testable without mounting the
// dnd component (the 3.2 BoardConfigEditor `computeColumnReorder` precedent).
// Positions are the shipped base-62 fractional index (`lib/workItems/
// positioning.ts`); the server re-mints authoritatively on the move endpoint,
// these compute the OPTIMISTIC placement so the drag feels instant.

export function columnCount(layout: DashboardLayout): number {
  return LAYOUT_COLUMN_COUNT[layout];
}

/** Widgets in one column, ascending by fractional position. */
export function widgetsInColumn(
  widgets: DashboardWidgetDto[],
  column: number,
): DashboardWidgetDto[] {
  return widgets
    .filter((w) => w.column === column)
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
}

/** One sorted list per column index `[0, colCount)`. A widget whose column
 * exceeds the layout (a not-yet-reflowed orphan) is clamped into the last
 * column so it never vanishes from the render. */
export function widgetsByColumn(
  widgets: DashboardWidgetDto[],
  colCount: number,
): DashboardWidgetDto[][] {
  const cols: DashboardWidgetDto[][] = Array.from({ length: colCount }, () => []);
  for (const w of widgets) {
    const idx = Math.min(Math.max(0, w.column), colCount - 1);
    cols[idx]!.push(w);
  }
  return cols.map((col) =>
    col.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)),
  );
}

export interface MovePlan {
  /** The full widget list with the moved widget's column + position updated. */
  widgets: DashboardWidgetDto[];
  column: number;
  afterId: string | null;
  beforeId: string | null;
  position: string;
}

/**
 * Compute the optimistic placement of `activeId` into `targetColumn`, inserted
 * BEFORE `overWidgetId` (or appended when it's null / not found) — plus the
 * neighbour ids the 6.3.1 move endpoint takes (it re-mints the position
 * server-side, the lock-before-read-derived-update rule). Returns null for a
 * no-op (dropped on itself, or unchanged position).
 */
export function computeWidgetMove(
  widgets: DashboardWidgetDto[],
  activeId: string,
  targetColumn: number,
  overWidgetId: string | null,
): MovePlan | null {
  const active = widgets.find((w) => w.id === activeId);
  if (!active) return null;
  if (overWidgetId === activeId) return null;

  const without = widgets.filter((w) => w.id !== activeId);
  const colList = widgetsInColumn(without, targetColumn);

  let insertAt = overWidgetId ? colList.findIndex((w) => w.id === overWidgetId) : colList.length;
  if (insertAt < 0) insertAt = colList.length;

  const prev = colList[insertAt - 1] ?? null;
  const next = colList[insertAt] ?? null;
  const position = keyBetween(prev?.position ?? null, next?.position ?? null);
  const moved: DashboardWidgetDto = { ...active, column: targetColumn, position };
  return {
    widgets: [...without, moved],
    column: targetColumn,
    afterId: prev?.id ?? null,
    beforeId: next?.id ?? null,
    position,
  };
}

/**
 * Mirror the server's layout-shrink reflow (the Jira edit-mode behaviour):
 * widgets orphaned in a column `>= colCount` rehome into the new LAST column,
 * appended after its existing widgets, preserving their relative order.
 */
export function reflowToLayout(
  widgets: DashboardWidgetDto[],
  colCount: number,
): DashboardWidgetDto[] {
  const last = colCount - 1;
  const orphans = widgets
    .filter((w) => w.column > last)
    .sort((a, b) =>
      a.column !== b.column ? a.column - b.column : a.position < b.position ? -1 : 1,
    );
  if (orphans.length === 0) return widgets;

  let tail = widgetsInColumn(widgets, last).at(-1)?.position ?? null;
  const moved = new Map<string, string>();
  for (const o of orphans) {
    tail = keyForAppend(tail);
    moved.set(o.id, tail);
  }
  return widgets.map((w) =>
    moved.has(w.id) ? { ...w, column: last, position: moved.get(w.id)! } : w,
  );
}
