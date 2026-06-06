'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { pageItems } from '@/lib/issues/issueListView';

// The List pagination footer (Subtask 2.5.12, finding #57) — the last row INSIDE
// the bordered List box, per design/work-items/list.mock.html panel 5 + the
// design-notes "server-paged navigator". Left: the "Showing 1–50 of N" range,
// where N is the count of the CURRENTLY FILTERED set (it tracks the 2.5.4
// filter). Right: a Prev chevron, numbered page buttons with ellipsis truncation
// (`1 … 12 [13] 14 … 25`), and a Next chevron; the current page is the accent
// chip + aria-current="page" (not colour alone — it's also the only filled,
// non-bordered button). Prev is disabled on page 1, Next on the last page.
//
// Presentational + URL-driven: it raises page changes via `onPage`; the parent
// (IssueListTable) navigates to the canonical ?page= href, so the Server
// Component re-reads the next page. No new primitive — page buttons are the
// shipped control affordance (--radius-control / --height-control), chevrons lucide.

const N = new Intl.NumberFormat('en-US');

export interface IssueListPagerProps {
  /** Count of the currently filtered set (the pager denominator). */
  total: number;
  /** The active 1-based page (already clamped by the service). */
  page: number;
  /** The fixed page size. */
  pageSize: number;
  /** Navigate to a page (the parent builds the ?page= href + pushes). */
  onPage: (page: number) => void;
}

const PG_BTN =
  'inline-flex h-(--height-control) min-w-(--height-control) items-center justify-center rounded-(--radius-control) px-(--spacing-control-x) font-sans text-[13px] font-medium focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export function IssueListPager({ total, page, pageSize, onPage }: IssueListPagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const items = pageItems(page, totalPages);
  const onFirst = page <= 1;
  const onLast = page >= totalPages;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-(--el-border) bg-(--el-surface-soft) px-3.5 py-2.5">
      {/* `--el-text-secondary` (not `-muted`): at 13px on `--el-surface-soft`
          muted is ~4.34:1 (below WCAG AA); secondary clears it (~6.5:1 light,
          ~6.9:1 dark). Surfaced by the 2.5.6 strict /issues a11y sweep. */}
      <span className="text-[13px] text-(--el-text-secondary)">
        Showing{' '}
        <strong className="font-semibold text-(--el-text)">
          {N.format(from)}–{N.format(to)}
        </strong>{' '}
        of <strong className="font-semibold text-(--el-text)">{N.format(total)}</strong>
      </span>

      {totalPages > 1 ? (
        <nav aria-label="Pagination" className="inline-flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous page"
            aria-disabled={onFirst}
            disabled={onFirst}
            onClick={() => onPage(page - 1)}
            className={cn(
              PG_BTN,
              'border border-(--el-border) bg-(--el-page-bg) text-(--el-text)',
              onFirst
                ? 'cursor-not-allowed text-(--el-text-faint) opacity-55'
                : 'hover:bg-(--el-surface)',
            )}
          >
            <ChevronLeft className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
          </button>

          {items.map((it, i) =>
            it === 'ellipsis' ? (
              <span
                key={`ellipsis-${i}`}
                aria-hidden
                className="min-w-6 text-center text-[13px] text-(--el-text-faint) select-none"
              >
                …
              </span>
            ) : it === page ? (
              <button
                key={it}
                type="button"
                aria-label={`Page ${it}`}
                aria-current="page"
                className={cn(
                  PG_BTN,
                  'cursor-default border border-transparent bg-(--el-accent) text-(--el-accent-text)',
                )}
              >
                {it}
              </button>
            ) : (
              <button
                key={it}
                type="button"
                aria-label={`Page ${it}`}
                onClick={() => onPage(it)}
                className={cn(
                  PG_BTN,
                  'border border-(--el-border) bg-(--el-page-bg) text-(--el-text) hover:bg-(--el-surface)',
                )}
              >
                {it}
              </button>
            ),
          )}

          <button
            type="button"
            aria-label="Next page"
            aria-disabled={onLast}
            disabled={onLast}
            onClick={() => onPage(page + 1)}
            className={cn(
              PG_BTN,
              'border border-(--el-border) bg-(--el-page-bg) text-(--el-text)',
              onLast
                ? 'cursor-not-allowed text-(--el-text-faint) opacity-55'
                : 'hover:bg-(--el-surface)',
            )}
          >
            <ChevronRight className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
          </button>
        </nav>
      ) : null}
    </div>
  );
}
