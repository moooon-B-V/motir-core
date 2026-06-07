import type { BoardColumnDto, PagedColumnCardsDto } from '@/lib/dto/boards';

// Pure per-column paging reducer (Subtask 3.2.5, finding #57) — the "load more"
// counterpart to boardMove.ts's optimistic-move reducers. The board never loads
// every card: Story 3.1.4 ships a bounded first page per column + a `cursor`; the
// DnD container fetches the next page from the Story-3.1.6 route
// (`GET /api/board/columns/[id]/cards?boardId=&cursor=`) and folds it in with
// `appendColumnPage`, advancing the cursor. Side-effect-free (columns-in,
// columns-out) so the page-append logic is unit-testable in isolation (the AC).
//
// `totalCount` is the projection denominator (count-of-all) and is NOT touched
// here — appending loaded cards never changes how many the column HAS, only how
// many are loaded. A null `cursor` means the bounded window is exhausted.

/** A column has another page to load iff it still carries a cursor. */
export function columnHasMore(column: BoardColumnDto): boolean {
  return column.cursor !== null;
}

/**
 * Append a fetched page to `columnId`: concatenate the page's cards DEDUPED by id
 * (so an overlapping or double-fired page never doubles a card — e.g. a card moved
 * into the column optimistically that the next server page also returns), and
 * advance the cursor to the page's. Other columns are returned unchanged; a no-op
 * shape if the column id isn't present.
 */
export function appendColumnPage(
  columns: BoardColumnDto[],
  columnId: string,
  page: PagedColumnCardsDto,
): BoardColumnDto[] {
  return columns.map((col) => {
    if (col.id !== columnId) return col;
    const seen = new Set(col.cards.map((c) => c.id));
    const fresh = page.cards.filter((c) => !seen.has(c.id));
    return { ...col, cards: [...col.cards, ...fresh], cursor: page.cursor };
  });
}
