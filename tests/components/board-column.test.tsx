// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { BoardColumn } from '@/app/(authed)/boards/_components/BoardColumn';
import type { BoardCardDto, BoardColumnDto } from '@/lib/dto/boards';

// BoardColumn (Subtask 3.2.3 · scale 3.2.5): a column header (name + per-column
// total count + a WIP-limit placeholder slot, not enforced) over a card stack,
// with the designed empty-column state, plus the finding-#57 "Load more" footer.
// Rendered with the real `en` catalog. Under happy-dom there is no measurable
// scroll viewport, so the windowing degrades to render-all (no absolute
// positioning) and the load-more affordance is driven purely by the cursor.

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

function renderColumn(
  col: BoardColumnDto,
  extra: Partial<{
    onOpenQuickView: (id: string) => void;
    onLoadMore: (id: string) => void;
    loadingMore: boolean;
    loadError: boolean;
    activeCardId: string | null;
  }> = {},
) {
  return render(
    <BoardColumn
      column={col}
      assigneeNameById={new Map()}
      onOpenQuickView={extra.onOpenQuickView ?? noop}
      onLoadMore={extra.onLoadMore ?? noop}
      loadingMore={extra.loadingMore ?? false}
      loadError={extra.loadError ?? false}
      activeCardId={extra.activeCardId ?? null}
    />,
  );
}

afterEach(cleanup);

describe('BoardColumn', () => {
  it('renders the column name and the per-column total count', () => {
    renderColumn(
      column({ id: 'c1', name: 'To Do', totalCount: 8, cards: [card({ id: 'w1', key: 1 })] }),
    );
    expect(screen.getByText('To Do')).toBeTruthy();
    // The count is the projection total, not the loaded card length.
    expect(screen.getByTestId('board-count-c1').textContent).toBe('8');
    expect(screen.getByTestId('board-card-PROD-1')).toBeTruthy();
  });

  it('renders the empty-column placeholder when the column has no cards', () => {
    renderColumn(column({ id: 'c2', name: 'In Review', totalCount: 0 }));
    expect(screen.getByText('No work items')).toBeTruthy();
    expect(screen.queryByTestId(/^board-card-/)).toBeNull();
  });

  it('renders the WIP-limit slot only when the column has a limit', () => {
    const { rerender } = renderColumn(
      column({ id: 'c1', name: 'In Progress', totalCount: 2, wipLimit: 5 }),
    );
    expect(screen.getByTestId('board-wip-c1').textContent).toBe('2/5');

    rerender(
      <BoardColumn
        column={column({ id: 'c1', name: 'To Do', totalCount: 2, wipLimit: null })}
        assigneeNameById={new Map()}
        onOpenQuickView={noop}
        onLoadMore={noop}
        loadingMore={false}
        loadError={false}
        activeCardId={null}
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
        onLoadMore={noop}
        loadingMore={false}
        loadError={false}
        activeCardId={null}
      />,
    );
    expect(screen.getByTitle('Assigned to Bea Lin')).toBeTruthy();
  });

  it('shows a "Load more" button only when the column still has a cursor', () => {
    const { rerender } = renderColumn(
      column({
        id: 'c1',
        name: 'To Do',
        totalCount: 60,
        cursor: '50',
        cards: [card({ id: 'w1', key: 1 })],
      }),
    );
    expect(screen.getByTestId('board-load-more-c1').textContent).toContain('Load more');

    // No cursor → no more pages → no footer button.
    rerender(
      <BoardColumn
        column={column({
          id: 'c1',
          name: 'To Do',
          totalCount: 1,
          cursor: null,
          cards: [card({ id: 'w1', key: 1 })],
        })}
        assigneeNameById={new Map()}
        onOpenQuickView={noop}
        onLoadMore={noop}
        loadingMore={false}
        loadError={false}
        activeCardId={null}
      />,
    );
    expect(screen.queryByTestId('board-load-more-c1')).toBeNull();
  });

  it('calls onLoadMore with the column id when the button is clicked', () => {
    const onLoadMore = vi.fn();
    renderColumn(
      column({
        id: 'c1',
        name: 'To Do',
        totalCount: 60,
        cursor: '50',
        cards: [card({ id: 'w1', key: 1 })],
      }),
      { onLoadMore },
    );
    fireEvent.click(screen.getByTestId('board-load-more-c1'));
    expect(onLoadMore).toHaveBeenCalledWith('c1');
  });

  it('shows the loading label (disabled) while a page is in flight', () => {
    renderColumn(
      column({
        id: 'c1',
        name: 'To Do',
        totalCount: 60,
        cursor: '50',
        cards: [card({ id: 'w1', key: 1 })],
      }),
      { loadingMore: true },
    );
    const btn = screen.getByTestId('board-load-more-c1') as HTMLButtonElement;
    expect(btn.textContent).toContain('Loading');
    expect(btn.disabled).toBe(true);
  });

  it('shows the error message + a Retry button after a failed load', () => {
    renderColumn(
      column({
        id: 'c1',
        name: 'To Do',
        totalCount: 60,
        cursor: '50',
        cards: [card({ id: 'w1', key: 1 })],
      }),
      { loadError: true },
    );
    expect(screen.getByText('Couldn’t load more cards.')).toBeTruthy();
    expect(screen.getByTestId('board-load-more-c1').textContent).toContain('Retry');
  });
});
