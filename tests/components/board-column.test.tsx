// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { BoardColumn } from '@/app/(authed)/boards/_components/BoardColumn';
import type { BoardCardDto, BoardColumnDto } from '@/lib/dto/boards';

// BoardColumn (Subtask 3.2.3 · scale 3.2.5 · WIP 3.3.6 · polish 3.2.8): a column
// header (name + per-column total count + the WIP chip + the `[⋯]` actions menu)
// over a card stack, with the designed empty-column state, plus the finding-#57
// PURE scroll-to-load (3.2.8 dropped the explicit "Load more" button + the loaded-
// count note): an IntersectionObserver sentinel auto-pages, a small spinner shows
// in flight, and a failed page leaves a focusable inline retry. Rendered with the
// real `en` catalog. Under happy-dom there is no measurable scroll viewport, so the
// windowing degrades to render-all (no absolute positioning) and the sentinel
// effect needs IntersectionObserver stubbed to fire.

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

  // 3.2.8 — paging is PURE scroll-to-load: the explicit "Load more" button and the
  // "{n} loaded" note are GONE. The IntersectionObserver sentinel is the only load
  // trigger; a spinner shows in flight and a failed page leaves a focusable retry.
  it('renders NO explicit "Load more" button or loaded-count note even with a cursor (3.2.8)', () => {
    renderColumn(
      column({
        id: 'c1',
        name: 'To Do',
        totalCount: 60,
        cursor: '50',
        cards: [card({ id: 'w1', key: 1 })],
      }),
    );
    // The dropped affordances must not reappear.
    expect(screen.queryByTestId('board-load-more-c1')).toBeNull();
    expect(screen.queryByTestId('board-virt-note-c1')).toBeNull();
    expect(screen.queryByText('Load more')).toBeNull();
  });

  it('auto-pages via the IntersectionObserver sentinel (no click), calling onLoadMore', () => {
    // Stub IntersectionObserver to capture the callback the column registers, then
    // fire an intersection — the sentinel is the sole load trigger now.
    const observed: Array<{ cb: IntersectionObserverCallback }> = [];
    class MockIO {
      cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
        observed.push({ cb });
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    const prior = globalThis.IntersectionObserver;
    // @ts-expect-error — test stub, only the constructor/observe surface is used
    globalThis.IntersectionObserver = MockIO;
    try {
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
      expect(observed.length).toBeGreaterThan(0);
      // The sentinel scrolls into view → the column pages the next slice.
      observed[observed.length - 1]!.cb(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      expect(onLoadMore).toHaveBeenCalledWith('c1');
    } finally {
      globalThis.IntersectionObserver = prior;
    }
  });

  it('shows a small in-flight spinner (not a button) while a page is loading', () => {
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
    expect(screen.getByTestId('board-loading-more-c1').textContent).toContain('Loading');
    expect(screen.queryByTestId('board-load-more-c1')).toBeNull();
  });

  it('shows a focusable inline retry after a failed load, calling onLoadMore on click', () => {
    const onLoadMore = vi.fn();
    renderColumn(
      column({
        id: 'c1',
        name: 'To Do',
        totalCount: 60,
        cursor: '50',
        cards: [card({ id: 'w1', key: 1 })],
      }),
      { loadError: true, onLoadMore },
    );
    const retry = screen.getByTestId('board-load-more-retry-c1');
    // Recoverable without a reload + keyboard-reachable: it's a real <button>.
    expect(retry.tagName).toBe('BUTTON');
    expect(retry.textContent).toContain('Retry');
    expect(screen.getByText('Couldn’t load more cards.', { exact: false })).toBeTruthy();
    fireEvent.click(retry);
    expect(onLoadMore).toHaveBeenCalledWith('c1');
  });

  it('renders every column at the same fixed height regardless of card count (3.2.8)', () => {
    renderColumn(
      column({ id: 'c1', name: 'To Do', totalCount: 1, cards: [card({ id: 'w1', key: 1 })] }),
    );
    const section = screen.getByTestId('board-column-c1');
    // A uniform viewport-relative height, not the old content-hugging max-height.
    expect(section.className).toContain('h-[calc(100dvh-12rem)]');
    expect(section.className).not.toContain('max-h-[calc(100dvh-12rem)]');
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
