'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import {
  buildIssueListHref,
  nextSort,
  type IssueSort,
  type IssueSortColumn,
} from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import { buildIssueColumns } from './issueColumns';
import { IssueListPager } from './IssueListPager';
import type { IssueRowData } from './issueRows';

// The flat, sortable LIST table (Subtask 2.5.8) — the `view=list` rendering the
// [Tree ▾] switcher toggles to, per design/work-items/list.mock.html. Same
// columns + cells as the Tree (issueColumns), but UN-NESTED (no indent, no
// chevrons) and with SORTABLE column headers. The rows arrive already sorted by
// the active column (the Server Component's flat DB read, getProjectIssuesList);
// clicking a header just navigates to the new ?sort= URL, so the server re-reads
// in the new order — sort state lives in the URL (shareable / reload-safe), the
// same serialization Epic 6's saved views will persist. No client re-sorting.
//
// A11y mirrors the TreeTable row pattern: each row is a positioned container
// with a STRETCHED link (absolute inset-0 z-0) covering it, so clicking anywhere
// navigates; the static cells stay below the link. Sortable headers are buttons
// inside role="columnheader" cells carrying aria-sort — required by the 2.5.6
// strict shell-a11y sweep, which exercises this view.

export interface IssueListTableProps {
  rows: IssueRowData[];
  sort: IssueSort;
  /** Preserved across a header-sort / page navigation (filtering applies to the List too). */
  filter: IssueFilter;
  /** The server-paged window (Subtask 2.5.12) — drives the footer pager. */
  pagination: { total: number; page: number; pageSize: number };
}

export function IssueListTable({ rows, sort, filter, pagination }: IssueListTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations();
  const columns = buildIssueColumns(t);

  // The grid template mirrors the TreeTable: the Title column flexes, the rest
  // take their fixed widths (Priority 120 · Assignee 150 · Reporter 150 · Due 120
  // · Est. 90 · Status 130).
  const gridTemplate = [
    'minmax(0,1fr)',
    ...columns.slice(1).map((c) => (c.width ? `${c.width}px` : 'max-content')),
  ].join(' ');

  const onSort = useCallback(
    (column: IssueSortColumn) => {
      // A sort change resets to page 1 (the new order invalidates the old page).
      router.push(
        buildIssueListHref(pathname, { view: 'list', sort: nextSort(sort, column), filter }),
      );
    },
    [router, pathname, sort, filter],
  );

  const onPage = useCallback(
    (page: number) => {
      router.push(buildIssueListHref(pathname, { view: 'list', sort, filter, page }));
    },
    [router, pathname, sort, filter],
  );

  return (
    <div className="overflow-hidden rounded-(--radius-card) border border-(--el-border)">
      <div
        role="table"
        aria-label={t('issues.list.tableLabel')}
        className="w-full text-sm"
        data-testid="issue-list-table"
      >
        {/* Header — sortable column buttons. */}
        <div role="rowgroup">
          <div
            role="row"
            className="sticky top-0 z-20 grid items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) pr-7 pl-4"
            style={{ gridTemplateColumns: gridTemplate, height: 40 }}
          >
            {columns.map((col) => {
              const active = sort.column === col.sortColumn;
              const ariaSort = active
                ? sort.direction === 'asc'
                  ? 'ascending'
                  : 'descending'
                : 'none';
              const Caret = active && sort.direction === 'desc' ? ChevronDown : ChevronUp;
              return (
                <div
                  key={col.key}
                  role="columnheader"
                  aria-sort={ariaSort}
                  className={cn('flex min-w-0 items-center', col.align === 'end' && 'justify-end')}
                >
                  <button
                    type="button"
                    onClick={() => onSort(col.sortColumn)}
                    title={t('issues.list.sortBy', { header: col.header })}
                    className="group/sort inline-flex max-w-full items-center gap-1 text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                  >
                    <span className="truncate">{col.header}</span>
                    <Caret
                      aria-hidden
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 transition-opacity',
                        active
                          ? 'text-(--el-text-secondary) opacity-100'
                          : 'text-(--el-text-faint) opacity-0 group-hover/sort:opacity-60',
                      )}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Body — flat rows, each a stretched link to the issue detail. */}
        <div role="rowgroup">
          {rows.map((row) => (
            <div
              key={row.identifier}
              role="row"
              data-testid={`issue-row-${row.identifier}`}
              className="group relative grid items-center gap-x-4 border-b border-(--el-border) pr-7 pl-4 last:border-b-0 hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2"
              style={{ gridTemplateColumns: gridTemplate, height: 44 }}
            >
              {/* Stretched link covers the whole row (the row is the positioned
                  ancestor); cells stay static below it so clicking anywhere
                  navigates — mirrors the TreeTable pattern. */}
              <Link
                href={`/issues/${row.identifier}`}
                aria-label={`${row.identifier} ${row.title}`}
                className="absolute inset-0 z-0 focus:outline-none"
              />
              {columns.map((col) => (
                <div
                  key={col.key}
                  role="cell"
                  className={cn('flex min-w-0 items-center', col.align === 'end' && 'justify-end')}
                >
                  {col.cell(row)}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Pagination footer — the last row inside the bordered box (2.5.12). */}
      <IssueListPager
        total={pagination.total}
        page={pagination.page}
        pageSize={pagination.pageSize}
        onPage={onPage}
      />
    </div>
  );
}
