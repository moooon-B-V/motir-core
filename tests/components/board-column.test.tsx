// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { BoardColumn } from '@/app/(authed)/boards/_components/BoardColumn';
import type { BoardCardDto, BoardColumnDto } from '@/lib/dto/boards';

// BoardColumn (Subtask 3.2.3): a column header (name + per-column total count + a
// WIP-limit placeholder slot, not enforced) over a card stack, with the designed
// empty-column state. Rendered with the real `en` catalog.

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

const noop = () => {};

afterEach(cleanup);

describe('BoardColumn', () => {
  it('renders the column name and the per-column total count', () => {
    render(
      <BoardColumn
        column={column({
          id: 'c1',
          name: 'To Do',
          totalCount: 8,
          cards: [card({ id: 'w1', key: 1 })],
        })}
        assigneeNameById={new Map()}
        onOpenQuickView={noop}
      />,
    );
    expect(screen.getByText('To Do')).toBeTruthy();
    // The count is the projection total, not the loaded card length.
    expect(screen.getByTestId('board-count-c1').textContent).toBe('8');
    expect(screen.getByTestId('board-card-PROD-1')).toBeTruthy();
  });

  it('renders the empty-column placeholder when the column has no cards', () => {
    render(
      <BoardColumn
        column={column({ id: 'c2', name: 'In Review', totalCount: 0 })}
        assigneeNameById={new Map()}
        onOpenQuickView={noop}
      />,
    );
    expect(screen.getByText('No work items')).toBeTruthy();
    expect(screen.queryByTestId(/^board-card-/)).toBeNull();
  });

  it('renders the WIP-limit slot only when the column has a limit', () => {
    const { rerender } = render(
      <BoardColumn
        column={column({ id: 'c1', name: 'In Progress', totalCount: 2, wipLimit: 5 })}
        assigneeNameById={new Map()}
        onOpenQuickView={noop}
      />,
    );
    expect(screen.getByTestId('board-wip-c1').textContent).toBe('2/5');

    rerender(
      <BoardColumn
        column={column({ id: 'c1', name: 'To Do', totalCount: 2, wipLimit: null })}
        assigneeNameById={new Map()}
        onOpenQuickView={noop}
      />,
    );
    expect(screen.queryByTestId('board-wip-c1')).toBeNull();
  });

  it('resolves a card assignee id to its display name via the lookup', () => {
    render(
      <BoardColumn
        column={column({
          id: 'c1',
          name: 'To Do',
          totalCount: 1,
          cards: [card({ id: 'w1', key: 1, assigneeId: 'u1' })],
        })}
        assigneeNameById={new Map([['u1', 'Bea Lin']])}
        onOpenQuickView={noop}
      />,
    );
    expect(screen.getByTitle('Assigned to Bea Lin')).toBeTruthy();
  });
});
