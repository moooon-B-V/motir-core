// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { BoardColumn } from '@/app/(authed)/boards/_components/BoardColumn';
import type { BoardCardDto, BoardColumnDto } from '@/lib/dto/boards';

// BoardColumn (Subtask 3.2.3 · scale 3.2.5 · WIP 3.3.6): a column header (name +
// per-column total count + the WIP chip + the `[⋯]` actions menu) over a card
// stack, with the designed empty-column state, plus the finding-#57 "Load more"
// footer. Rendered with the real `en` catalog. Under happy-dom there is no
// measurable scroll viewport, so the windowing degrades to render-all (no
// absolute positioning) and the load-more affordance is driven purely by the
// cursor.

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
    onSetWipLimit: (columnId: string, limit: number | null) => void;
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
      onSetWipLimit={extra.onSetWipLimit ?? noop}
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
        onSetWipLimit={noop}
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
        onSetWipLimit={noop}
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

// The WIP chip — under / at / over (strictly-greater) + the no-limit plain
// state. SOFT: the over state is a presentational warning ONLY (it never gates
// a drop). Per panel 6 of `design/boards/swimlanes-wip.mock.html`.
describe('BoardColumn — WIP chip (3.3.6)', () => {
  it('shows no WIP chip when the column has no limit (plain count only)', () => {
    renderColumn(column({ id: 'c1', name: 'In Progress', totalCount: 8, wipLimit: null }));
    expect(screen.queryByTestId('board-wip-c1')).toBeNull();
    expect(screen.getByTestId('board-count-c1').textContent).toBe('8');
  });

  it('renders the quiet `n/limit` chip UNDER the limit, no warning', () => {
    renderColumn(column({ id: 'c1', name: 'In Progress', totalCount: 3, wipLimit: 5 }));
    const chip = screen.getByTestId('board-wip-c1');
    expect(chip.textContent).toBe('3/5');
    expect(chip.getAttribute('role')).toBeNull();
    expect(chip.getAttribute('data-over')).toBeNull();
  });

  it('does NOT warn AT the limit (n == limit is at-limit, not over)', () => {
    renderColumn(column({ id: 'c1', name: 'In Progress', totalCount: 5, wipLimit: 5 }));
    const chip = screen.getByTestId('board-wip-c1');
    expect(chip.textContent).toBe('5/5');
    expect(chip.getAttribute('role')).toBeNull();
    expect(chip.getAttribute('data-over')).toBeNull();
  });

  it('warns OVER the limit (n > limit) with a status role + paired icon, not colour-alone', () => {
    renderColumn(column({ id: 'c1', name: 'In Progress', totalCount: 6, wipLimit: 5 }));
    const chip = screen.getByTestId('board-wip-c1');
    expect(chip.textContent).toContain('6/5');
    expect(chip.getAttribute('data-over')).toBe('true');
    expect(chip.getAttribute('role')).toBe('status');
    expect(chip.getAttribute('aria-label')).toBe('6 of 5 issues — over the WIP limit');
    expect(chip.querySelector('svg')).toBeTruthy();
  });
});

// The column `[⋯]` menu's "Set WIP limit" editor (panel 5). Save parses the
// integer and hands it up; Clear hands up null; an invalid entry is blocked
// client-side and never reaches the handler.
describe('BoardColumn — WIP config menu (3.3.6)', () => {
  function openMenu(
    onSetWipLimit: (id: string, n: number | null) => void,
    wipLimit: number | null = null,
  ) {
    renderColumn(column({ id: 'c1', name: 'In Progress', totalCount: 3, wipLimit }), {
      onSetWipLimit,
    });
    fireEvent.click(screen.getByTestId('board-column-actions-c1'));
    fireEvent.click(screen.getByText('Set WIP limit'));
  }

  it('saves a valid non-negative integer via onSetWipLimit', () => {
    const onSet = vi.fn();
    openMenu(onSet);
    fireEvent.change(screen.getByTestId('board-wip-input-c1'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSet).toHaveBeenCalledWith('c1', 4);
  });

  it('clears the limit (onSetWipLimit with null) via Clear', () => {
    const onSet = vi.fn();
    openMenu(onSet, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onSet).toHaveBeenCalledWith('c1', null);
  });

  it('blocks an invalid (negative / non-integer) entry client-side and does not call onSetWipLimit', () => {
    const onSet = vi.fn();
    openMenu(onSet);
    fireEvent.change(screen.getByTestId('board-wip-input-c1'), { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSet).not.toHaveBeenCalled();
    expect(screen.getByTestId('board-wip-error-c1').textContent).toBe(
      'Enter a non-negative whole number.',
    );
  });
});
