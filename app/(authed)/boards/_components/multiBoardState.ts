import type { BoardSummaryDto } from '@/lib/dto/boards';

// Pure helpers for the board switcher (Subtask 3.7.4) — extracted so the
// selection / optimistic-CRUD logic is unit-testable without rendering the
// component. The switcher is a pure consumer of the 3.7.3 board API; these
// functions own the local-list reconciliation the optimistic-with-reconcile
// writes apply before/after each round-trip. (Named `multiBoardState` rather
// than `boardSwitcher*` so it can't collide with `BoardSwitcher.tsx` under a
// case-insensitive filesystem's `.ts`-before-`.tsx` module resolution.)

/**
 * Boards in switcher order — by the fractional-index `position` (3.7.2), the
 * opaque sort key the server assigns. A stable string compare; never a numeric
 * parse (the key is an opaque fractional index, not a number).
 */
export function sortBoards(boards: BoardSummaryDto[]): BoardSummaryDto[] {
  return [...boards].sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
  );
}

/**
 * The board the switcher renders as active: the `?board=` param when it names a
 * board the project actually has, else the project's `isDefault` board, else the
 * first board (defensive — a project always has a default). Absent boards → null
 * (the loading / error states have no active board yet). Mirrors the 3.7.5
 * server-side default-fallback so the client highlight matches what the read
 * path resolves.
 */
export function resolveActiveBoardId(
  boards: BoardSummaryDto[],
  boardParam: string | null,
): string | null {
  if (boards.length === 0) return null;
  if (boardParam && boards.some((b) => b.id === boardParam)) return boardParam;
  const def = boards.find((b) => b.isDefault);
  return (def ?? boards[0]!).id;
}

/**
 * Optimistically promote `id` to the project default — exactly one default per
 * project (the 3.7.2 partial-unique invariant), so set it on `id` and clear it
 * on every other board. Reconciled to the returned DTO after the PATCH.
 */
export function applyDefault(boards: BoardSummaryDto[], id: string): BoardSummaryDto[] {
  return boards.map((b) => ({ ...b, isDefault: b.id === id }));
}

/** Optimistically replace one board with the server-returned DTO (rename / create reconcile). */
export function upsertBoard(boards: BoardSummaryDto[], board: BoardSummaryDto): BoardSummaryDto[] {
  const exists = boards.some((b) => b.id === board.id);
  const next = exists ? boards.map((b) => (b.id === board.id ? board : b)) : [...boards, board];
  return sortBoards(next);
}

/**
 * Remove a deleted board and keep the one-default invariant: if the deleted
 * board was the default, promote the next board by position to default (the
 * server's `deleteBoard` does the same — this mirrors it locally so the switcher
 * stays consistent without a refetch). Returns the new list + the id now
 * holding the default (for the caller to switch to if the deleted board was
 * active). A project always keeps ≥1 board, so the caller never deletes the last
 * one; if it somehow does, `promotedDefaultId` is null.
 */
export function applyDelete(
  boards: BoardSummaryDto[],
  id: string,
): { boards: BoardSummaryDto[]; promotedDefaultId: string | null } {
  const removedWasDefault = boards.find((b) => b.id === id)?.isDefault ?? false;
  let next = sortBoards(boards.filter((b) => b.id !== id));
  if (next.length === 0) return { boards: next, promotedDefaultId: null };
  if (removedWasDefault && !next.some((b) => b.isDefault)) {
    const promoted = next[0]!;
    next = next.map((b) => ({ ...b, isDefault: b.id === promoted.id }));
    return { boards: next, promotedDefaultId: promoted.id };
  }
  return { boards: next, promotedDefaultId: next.find((b) => b.isDefault)?.id ?? null };
}
