// The board-scoped filter URL contract (Story 6.15 · Subtask 6.15.3). The board
// REUSES the /items filter components verbatim (`IssueFilterBar` quick popover ·
// `IssueAdvancedFilter` builder · `SavedFilterDropdown` picker · the applied
// summary bar) — but those components serialize their state with
// `buildIssueListHref`, which builds a FRESH querystring carrying `view`/`sort`/
// `page` and would DROP the board's `?board=<id>` selection. The board has no
// view/sort/page; it has the `?board=` selection to preserve. So this module is
// the board's `buildHref` — the same `appendFilterParams` serialization (the
// facets + the advanced `?filter=v1:` param), composed onto the `?board=`
// selection so the active filter is shareable, reload-safe, and PER BOARD
// (switching boards does not leak the filter). Pure (no React) → unit-tested in
// isolation, and injected into the reused components as their `buildHref` prop.

import { appendFilterParams, type IssueFilter } from '@/lib/issues/issueListFilter';

/** The board route the filter lives on (mirrors `?board=` selection state). */
const BOARD_PATH = '/boards';

/**
 * Build the canonical `/boards` href for a filter, preserving the `?board=`
 * selection. The filter params (`kind`/`type`/`status`/`assignee`/`q` facets +
 * the advanced `?filter=v1:` param) are appended in the same canonical order
 * `buildIssueListHref` uses, so a board filter URL round-trips identically to an
 * /items one (only the route + the `?board=` companion differ). The `?peek=`
 * quick-view param is intentionally NOT carried: a filter edit happens from the
 * toolbar, not while a card peek modal traps focus, and the re-projected board
 * is what the user is acting on.
 */
export function buildBoardFilterHref(opts: { boardId?: string; filter: IssueFilter }): string {
  const params = new URLSearchParams();
  // `?board=` first so it leads the querystring (the selection is the board's
  // primary axis; the filter narrows WITHIN it).
  if (opts.boardId) params.set('board', opts.boardId);
  appendFilterParams(params, opts.filter);
  const qs = params.toString();
  return qs ? `${BOARD_PATH}?${qs}` : BOARD_PATH;
}
