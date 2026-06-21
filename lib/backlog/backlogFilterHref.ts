import { appendFilterParams, type IssueFilter } from '@/lib/issues/issueListFilter';

// The backlog-scoped filter URL contract (Story 8.8 · Subtask 8.8.18). The
// backlog REUSES the /issues filter components verbatim (`IssueFilterBar` quick
// popover · `IssueAdvancedFilter` builder · `SavedFilterDropdown` picker · the
// applied summary bar) — exactly as the board did (6.15.3) — but those components
// serialize their state with `buildIssueListHref`, which builds a FRESH
// querystring carrying `view`/`sort`/`page` the backlog has none of. So this
// module is the backlog's `buildHref`: the same `appendFilterParams`
// serialization (the facets + the advanced `?filter=v1:` param) onto the plain
// `/backlog` route, so the active filter is shareable + reload-safe. Pure (no
// React) → unit-tested in isolation, injected into the reused components as their
// `buildHref` prop. Unlike the board there is no `?board=` companion and no
// `view`/`sort`/`page` (the backlog is cursor-paginated, so a filter change just
// resets to a fresh first page — there is no `page` param to drop).

/** The backlog route the filter lives on. */
const BACKLOG_PATH = '/backlog';

/**
 * Build the canonical `/backlog` href for a filter. The filter params
 * (`kind`/`type`/`status`/`assignee`/`q` facets + the advanced `?filter=v1:`
 * param) are appended in the same canonical order `buildIssueListHref` uses, so a
 * backlog filter URL round-trips identically to an /issues one (only the route +
 * the absent view/sort differ). An empty filter → the bare `/backlog`.
 */
export function buildBacklogFilterHref(opts: { filter: IssueFilter }): string {
  const params = new URLSearchParams();
  appendFilterParams(params, opts.filter);
  const qs = params.toString();
  return qs ? `${BACKLOG_PATH}?${qs}` : BACKLOG_PATH;
}
