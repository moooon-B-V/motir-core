// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import type { ReactNode } from 'react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { SwimlaneBoard } from '@/app/(authed)/boards/_components/SwimlaneBoard';
import { COLLAPSED_LANES_STORAGE_PREFIX } from '@/lib/hooks/useCollapsedLanes';
import {
  BOARD_SWIMLANE_NO_VALUE,
  type BoardCardDto,
  type BoardColumnDto,
  type BoardSwimlaneDto,
} from '@/lib/dto/boards';

// SwimlaneBoard (Subtask 3.3.5): the board re-laid into a (column × lane) grid.
// Rendered with the real `en` catalog inside a DndContext (LaneCell registers a
// dnd-kit droppable, BoardCard a sortable). Under happy-dom windowing degrades
// to render-all. Covers lane rendering + ordering (catch-all last), bucketing by
// swimlaneKey, the per-lane aggregate count, and collapse persistence.

function card(over: Partial<BoardCardDto> & { id: string; key: number }): BoardCardDto {
  return {
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Card ${over.key}`,
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    estimateMinutes: null,
    position: 'a0',
    ready: true,
    ...over,
  };
}

function column(over: Partial<BoardColumnDto> & { id: string; name: string }): BoardColumnDto {
  return {
    position: 'a0',
    wipLimit: null,
    statusKeys: ['todo'],
    cards: [],
    totalCount: 0,
    cursor: null,
    ...over,
  };
}

const COLUMNS = [
  column({
    id: 'c1',
    name: 'To Do',
    totalCount: 3,
    cards: [
      card({ id: 'w1', key: 1, swimlaneKey: 'u1', assigneeId: 'u1' }),
      card({ id: 'w2', key: 2, swimlaneKey: 'u2', assigneeId: 'u2' }),
      card({ id: 'w3', key: 3 }), // no assignee → catch-all
    ],
  }),
  column({
    id: 'c2',
    name: 'Done',
    totalCount: 1,
    cards: [card({ id: 'w4', key: 4, swimlaneKey: 'u1', assigneeId: 'u1' })],
  }),
];

const SWIMLANES: BoardSwimlaneDto[] = [
  { key: 'u1', label: 'Ana Ruiz', kind: 'assignee', count: 2 },
  { key: 'u2', label: 'Bea Lin', kind: 'assignee', count: 1 },
  { key: BOARD_SWIMLANE_NO_VALUE, label: 'No assignee', kind: 'assignee', count: 1 },
];

const noop = () => {};

function renderBoard(boardId: string): ReactNode {
  return render(
    <DndContext>
      <SwimlaneBoard
        boardId={boardId}
        columns={COLUMNS}
        swimlanes={SWIMLANES}
        assigneeNameById={
          new Map([
            ['u1', 'Ana Ruiz'],
            ['u2', 'Bea Lin'],
          ])
        }
        onOpenQuickView={noop}
        onLoadMore={noop}
        paging={{}}
        activeCardId={null}
        overLaneKey={null}
      />
    </DndContext>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('SwimlaneBoard', () => {
  it('renders one lane per projection swimlane, catch-all sorted last', () => {
    renderBoard('b-order');
    const heads = screen.getAllByTestId(/^swimlane-head-/);
    expect(heads.map((h) => h.getAttribute('data-testid'))).toEqual([
      'swimlane-head-u1',
      'swimlane-head-u2',
      `swimlane-head-${BOARD_SWIMLANE_NO_VALUE}`,
    ]);
  });

  it('buckets each card into its (lane, column) cell by swimlaneKey', () => {
    renderBoard('b-bucket');
    // w1 (u1) and w4 (u1) sit in lane u1's c1 / c2 cells; w2 (u2) in lane u2's c1.
    expect(
      within(screen.getByTestId('lane-cell-c1-u1')).getByTestId('board-card-PROD-1'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('lane-cell-c2-u1')).getByTestId('board-card-PROD-4'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('lane-cell-c1-u2')).getByTestId('board-card-PROD-2'),
    ).toBeTruthy();
    // The keyless card lands in the catch-all lane's c1 cell.
    expect(
      within(screen.getByTestId(`lane-cell-c1-${BOARD_SWIMLANE_NO_VALUE}`)).getByTestId(
        'board-card-PROD-3',
      ),
    ).toBeTruthy();
  });

  it('shows the per-lane aggregate count from the projection', () => {
    renderBoard('b-count');
    expect(screen.getByTestId('swimlane-count-u1').textContent).toBe('2');
    expect(screen.getByTestId('swimlane-count-u2').textContent).toBe('1');
  });

  it('renders the per-column total count in the pinned header', () => {
    renderBoard('b-colcount');
    expect(screen.getByTestId('board-count-c1').textContent).toBe('3');
    expect(screen.getByTestId('board-count-c2').textContent).toBe('1');
  });

  it('reads persisted collapse state on mount (lane hidden, header kept)', () => {
    window.localStorage.setItem(
      COLLAPSED_LANES_STORAGE_PREFIX + 'b-persist',
      JSON.stringify(['u1']),
    );
    renderBoard('b-persist');
    // u1 collapsed → its cells are not rendered, but its header + count remain.
    expect(screen.queryByTestId('lane-cell-c1-u1')).toBeNull();
    expect(screen.getByTestId('swimlane-head-u1')).toBeTruthy();
    expect(screen.getByTestId('swimlane-count-u1').textContent).toBe('2');
    // u2 stays expanded.
    expect(screen.getByTestId('lane-cell-c1-u2')).toBeTruthy();
  });

  it('toggling a lane collapses it and persists the choice to localStorage', () => {
    renderBoard('b-toggle');
    expect(screen.getByTestId('lane-cell-c1-u1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('swimlane-head-u1'));
    expect(screen.queryByTestId('lane-cell-c1-u1')).toBeNull();
    const stored = window.localStorage.getItem(COLLAPSED_LANES_STORAGE_PREFIX + 'b-toggle');
    expect(JSON.parse(stored ?? '[]')).toContain('u1');
  });
});
