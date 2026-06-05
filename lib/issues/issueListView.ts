// The /issues view + sort URL contract (Subtask 2.5.8). The `[Tree ▾]`
// switcher toggles between the nested Tree view (2.5.2/2.5.3) and a flat,
// sortable List view; BOTH the chosen view and the List's active sort live in
// the URL (`?view=list&sort=key:asc`) — shareable, reload-safe, and the same
// serialization Epic 6's saved views will persist. This module is the single,
// UI-free source of truth for parsing + serializing those params and the
// header-click sort transition, so the Server Component (read side), the client
// switcher, and the client List header all agree. Kept pure (no React, no
// Prisma) → unit-tested in isolation.

import { appendFilterParams, type IssueFilter } from '@/lib/issues/issueListFilter';

/** The two issue-list views the switcher toggles. Tree is the default. */
export type IssueListView = 'tree' | 'list';

/**
 * The columns the flat List can sort by — one per drawn `list.mock.html`
 * header. `key` is the issue key (the mono identifier leading the Title cell —
 * the canonical issue order + the default). `assignee`/`reporter` sort by
 * display name; `status` by the project workflow's status order; the rest are
 * the work-item scalar columns.
 */
export type IssueSortColumn =
  | 'key'
  | 'title'
  | 'priority'
  | 'assignee'
  | 'reporter'
  | 'due'
  | 'estimate'
  | 'status';

export type SortDirection = 'asc' | 'desc';

export interface IssueSort {
  column: IssueSortColumn;
  direction: SortDirection;
}

/** Every sortable column, in the drawn left-to-right header order. */
export const ISSUE_SORT_COLUMNS: readonly IssueSortColumn[] = [
  'key',
  'title',
  'priority',
  'assignee',
  'reporter',
  'due',
  'estimate',
  'status',
];

/** The default sort the List opens with (matches the 2.5.8 AC + the mock). */
export const DEFAULT_SORT: IssueSort = { column: 'key', direction: 'asc' };

const SORT_COLUMN_SET = new Set<string>(ISSUE_SORT_COLUMNS);

/** `?view=list` → `'list'`; anything else (incl. absent) → the `'tree'` default. */
export function parseView(raw: string | string[] | undefined): IssueListView {
  return raw === 'list' ? 'list' : 'tree';
}

/**
 * Parse `?sort=column:direction` into a validated `IssueSort`. Unknown columns,
 * bad directions, or an absent param all fall back to {@link DEFAULT_SORT} — the
 * read path must never receive an un-whitelisted column (it maps straight to a
 * SQL ORDER BY).
 */
export function parseSort(raw: string | string[] | undefined): IssueSort {
  if (typeof raw !== 'string') return DEFAULT_SORT;
  const [column, direction] = raw.split(':');
  if (column === undefined || !SORT_COLUMN_SET.has(column)) return DEFAULT_SORT;
  if (direction !== 'asc' && direction !== 'desc') return DEFAULT_SORT;
  return { column: column as IssueSortColumn, direction };
}

/** `IssueSort` → `"column:direction"` for the URL. */
export function serializeSort(sort: IssueSort): string {
  return `${sort.column}:${sort.direction}`;
}

function isDefaultSort(sort: IssueSort): boolean {
  return sort.column === DEFAULT_SORT.column && sort.direction === DEFAULT_SORT.direction;
}

/**
 * The header-click transition: clicking the ACTIVE column flips its direction;
 * clicking a different column makes it the active sort, ascending. (Single-
 * column sort — multi-sort is Epic 6.)
 */
export function nextSort(current: IssueSort, column: IssueSortColumn): IssueSort {
  if (current.column === column) {
    return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { column, direction: 'asc' };
}

/**
 * Build the canonical `/issues` href for a (view, sort, filter) triple. Defaults
 * are OMITTED so URLs stay clean: `view=tree` and the default `key:asc` sort
 * never appear (`/issues` is the canonical Tree URL; `/issues?view=list` is the
 * List at its default sort). The optional `filter` (Subtask 2.5.4) is appended
 * regardless of view — filtering applies to BOTH the Tree and the List — so the
 * switcher + the List sort headers PRESERVE the active filter when they
 * navigate (and the filter bar preserves the active view + sort). All three
 * controls route through here, so every produced URL is identical + shareable.
 */
export function buildIssueListHref(
  pathname: string,
  opts: { view: IssueListView; sort?: IssueSort; filter?: IssueFilter },
): string {
  const params = new URLSearchParams();
  if (opts.view === 'list') params.set('view', 'list');
  // Sort applies to BOTH views (the List since 2.5.8, the Tree since 2.5.14 —
  // sorting siblings within their parent), emitted only when it's not the
  // default `key` asc so a default-sorted URL stays canonical.
  if (opts.sort && !isDefaultSort(opts.sort)) {
    params.set('sort', serializeSort(opts.sort));
  }
  // Filter applies to both views; appended in canonical order (see appendFilterParams).
  if (opts.filter) appendFilterParams(params, opts.filter);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
