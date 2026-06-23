// The /items view + sort URL contract (Subtask 2.5.8). The `[Tree ▾]`
// switcher toggles between the nested Tree view (2.5.2/2.5.3) and a flat,
// sortable List view; BOTH the chosen view and the List's active sort live in
// the URL (`?view=list&sort=key:asc`) — shareable, reload-safe, and the same
// serialization Epic 6's saved views will persist. This module is the single,
// UI-free source of truth for parsing + serializing those params and the
// header-click sort transition, so the Server Component (read side), the client
// switcher, and the client List header all agree. Kept pure (no React, no
// Prisma) → unit-tested in isolation.

import { appendFilterParams, type IssueFilter } from '@/lib/issues/issueListFilter';

/**
 * The minimum width of the flexible **Title** track in the issue list/tree grid
 * (bug MOTIR-1307). The Title column is `minmax(<this>, 1fr)` in every view
 * (List · lazy Tree · static Tree) so that, under width pressure, the track
 * never collapses to 0 and lets the title cell's non-shrinkable content (the
 * type icon + `MOTIR-N` identifier) spill into — and overlap — the adjacent
 * Type column. A `minmax(0,1fr)` floor of `0` is exactly what caused that
 * overlap on narrow viewports; this floor clears the icon + identifier with a
 * little title still showing. Single-sourced here so all three table views agree.
 */
export const ISSUE_TITLE_MIN_TRACK = '10rem';

/** The two issue-list views the switcher toggles. Tree is the default. */
export type IssueListView = 'tree' | 'list';

/**
 * The columns the flat List can sort by — one per drawn `list.mock.html`
 * header. `key` is the issue key (the mono identifier leading the Title cell —
 * the canonical issue order + the default). `assignee`/`reporter` sort by
 * display name; `status` by the project workflow's status order; `type` by the
 * work-item-type enum order (the Type column, Subtask 8.8.9); the rest are the
 * work-item scalar columns.
 */
export type IssueSortColumn =
  | 'key'
  | 'title'
  | 'type'
  | 'priority'
  | 'assignee'
  | 'reporter'
  | 'due'
  | 'estimate'
  | 'points'
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
  'type',
  'priority',
  'assignee',
  'reporter',
  'due',
  'estimate',
  'points',
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

/**
 * The List's fixed page size (Subtask 2.5.12, the 2.5.10 design constant —
 * Epic 6 may make it configurable; not here). The flat List is server-paged
 * (LIMIT/OFFSET + count) so it never loads the whole backlog (finding #57).
 */
export const ISSUE_LIST_PAGE_SIZE = 50;

/**
 * Parse `?page=N` into a 1-based page index. Non-numeric / `< 1` / absent → 1.
 * The UPPER bound is NOT clamped here — the parser is filter-blind, so the
 * service clamps an out-of-range page to the last page once it knows the
 * filtered total (the 2.5.10 edge spec). The Tree view ignores `page` (a
 * hierarchy can't be cut at row N; it scales via lazy-load, 2.5.13/2.5.14).
 */
export function parsePage(raw: string | string[] | undefined): number {
  if (typeof raw !== 'string') return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** A pager slot: a concrete page number, or a collapsed-gap marker. */
export type PageItem = number | 'ellipsis';

/**
 * The page-number sequence for the List pager (Subtask 2.5.12), matching the
 * 2.5.10 design: always the first + last page, a 3-wide window around the
 * current page, and an `'ellipsis'` wherever a gap of >1 is collapsed. Examples
 * (totalPages 25): page 1 → `[1,2,3,'ellipsis',25]`; page 13 →
 * `[1,'ellipsis',12,13,14,'ellipsis',25]`; page 25 → `[1,'ellipsis',23,24,25]`.
 * A small set (≤7 pages) shows every page with no ellipsis.
 */
export function pageItems(current: number, totalPages: number): PageItem[] {
  const total = Math.max(totalPages, 1);
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const shown = new Set<number>([1, total, current, current - 1, current + 1]);
  // Always show three pages at the touched edge (matches the drawn panels).
  if (current <= 3) [2, 3].forEach((p) => shown.add(p));
  if (current >= total - 2) [total - 1, total - 2].forEach((p) => shown.add(p));
  const pages = [...shown].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const items: PageItem[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (i > 0 && pages[i]! - pages[i - 1]! > 1) items.push('ellipsis');
    items.push(pages[i]!);
  }
  return items;
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
 * Build the canonical `/items` href for a (view, sort, filter) triple. Defaults
 * are OMITTED so URLs stay clean: `view=tree` and the default `key:asc` sort
 * never appear (`/items` is the canonical Tree URL; `/items?view=list` is the
 * List at its default sort). The optional `filter` (Subtask 2.5.4) is appended
 * regardless of view — filtering applies to BOTH the Tree and the List — so the
 * switcher + the List sort headers PRESERVE the active filter when they
 * navigate (and the filter bar preserves the active view + sort). All three
 * controls route through here, so every produced URL is identical + shareable.
 */
export function buildIssueListHref(
  pathname: string,
  opts: { view: IssueListView; sort?: IssueSort; filter?: IssueFilter; page?: number },
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
  // Page only applies to the List, and only past page 1 (page 1 is the clean
  // canonical URL — so a sort/filter change, which omits page, resets to page 1).
  if (opts.view === 'list' && opts.page && opts.page > 1) {
    params.set('page', String(opts.page));
  }
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
