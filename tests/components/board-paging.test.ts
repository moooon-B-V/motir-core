import { describe, expect, it } from 'vitest';
import { appendColumnPage, columnHasMore } from '@/app/(authed)/boards/_components/boardPaging';
import type { BoardCardDto, BoardColumnDto, PagedColumnCardsDto } from '@/lib/dto/boards';

// Pure per-column paging reducer (Subtask 3.2.5, finding #57): the "load more"
// page-append logic — cursor advance, no duplicate cards, count untouched. Tested
// in isolation, columns-in / columns-out, no network or React.

function card(id: string, key: number): BoardCardDto {
  return {
    id,
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    key,
    identifier: `PROD-${key}`,
    title: `Card ${key}`,
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    estimateMinutes: null,
    position: `a${key}`,
    ready: true,
  };
}

function column(over: Partial<BoardColumnDto> & { id: string }): BoardColumnDto {
  return {
    name: 'To Do',
    position: 'a0',
    wipLimit: null,
    statusKeys: ['todo'],
    cards: [],
    totalCount: 0,
    cursor: null,
    ...over,
  };
}

function page(cards: BoardCardDto[], cursor: string | null): PagedColumnCardsDto {
  return { cards, cursor };
}

describe('columnHasMore', () => {
  it('is true iff the column carries a cursor', () => {
    expect(columnHasMore(column({ id: 'c1', cursor: '50' }))).toBe(true);
    expect(columnHasMore(column({ id: 'c1', cursor: null }))).toBe(false);
  });
});

describe('appendColumnPage', () => {
  it('appends the page and advances the cursor on the target column only', () => {
    const cols = [
      column({ id: 'c1', cards: [card('w1', 1), card('w2', 2)], cursor: '50', totalCount: 130 }),
      column({ id: 'c2', cards: [card('x1', 9)], cursor: '50', totalCount: 60 }),
    ];
    const next = appendColumnPage(cols, 'c1', page([card('w3', 3), card('w4', 4)], '100'));

    const c1 = next.find((c) => c.id === 'c1')!;
    expect(c1.cards.map((c) => c.id)).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(c1.cursor).toBe('100');
    // totalCount is the denominator — appending loaded cards never changes it.
    expect(c1.totalCount).toBe(130);
    // Other columns are returned untouched (same reference).
    expect(next.find((c) => c.id === 'c2')).toBe(cols[1]);
  });

  it('dedupes by id so an overlapping / double-fired page never doubles a card', () => {
    const cols = [column({ id: 'c1', cards: [card('w1', 1), card('w2', 2)], cursor: '2' })];
    // The page re-includes w2 (e.g. a card optimistically moved in that the next
    // server page also returns) plus a genuinely new w3.
    const next = appendColumnPage(cols, 'c1', page([card('w2', 2), card('w3', 3)], null));

    const c1 = next[0]!;
    expect(c1.cards.map((c) => c.id)).toEqual(['w1', 'w2', 'w3']);
    expect(c1.cursor).toBeNull();
  });

  it('sets the cursor to null at the end of the column window (no more pages)', () => {
    const cols = [column({ id: 'c1', cards: [card('w1', 1)], cursor: '50' })];
    const next = appendColumnPage(cols, 'c1', page([card('w2', 2)], null));
    expect(columnHasMore(next[0]!)).toBe(false);
  });

  it('is a no-op shape when the column id is absent', () => {
    const cols = [column({ id: 'c1', cards: [card('w1', 1)], cursor: '50' })];
    const next = appendColumnPage(cols, 'ZZ', page([card('w9', 9)], null));
    expect(next).toEqual(cols);
  });
});
