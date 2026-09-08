'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
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
//
// ⚠️ TRANSLATED IN PLACE (MOTIR-4853), and its two existing consumers inherit
// it. This control shipped for months with `Showing`, `Page N`, `Previous page`,
// `Next page` and `Pagination` written into it as English literals, and its
// number formatting pinned to `en-US` — invisible because `/items` and
// `/items/archived` never forced the question. The Workbench does: it is the
// surface that ships in both languages, and the whole point of composing the
// shipped control rather than writing a second one is that there is exactly ONE
// pager in the product. So the gap is paid IN the component, not around it.
//
// The strings live in `common.pager` — where a control is read from when no
// single surface owns it — and `design/workbench/design-notes.md` § The pager →
// The copy is where their `en` / `zh` values are named.
//
// ⚠️ THE RANGE LINE IS `t.rich`, NOT A CONCATENATION, and that is a translation
// decision rather than a styling one. Its two numbers are bold, and Chinese puts
// its measure words AROUND them (`显示第 X–Y 项，共 N 项`) — so a sentence
// assembled from fragments in JSX would pin the English word order into the
// markup. The tags are what let a translator move the emphasis with the words.
// (`<count>`, not `<total>`: `total` is already a VALUE in the same message, and
// next-intl resolves the two namespaces together.)

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
  const t = useTranslations('common.pager');
  // ⚠️ The ACTIVE locale, not `en-US`. The grouping separator only shows on a
  // four-figure total, which is exactly the number on this control a reader
  // could misread if it were grouped by someone else's convention.
  const N = new Intl.NumberFormat(useLocale());
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
          ~6.9:1 dark). Surfaced by the 2.5.6 strict /items a11y sweep. */}
      <span className="text-[13px] text-(--el-text-secondary)">
        {t.rich('showing', {
          from: N.format(from),
          to: N.format(to),
          total: N.format(total),
          range: (chunks) => <strong className="font-semibold text-(--el-text)">{chunks}</strong>,
          count: (chunks) => <strong className="font-semibold text-(--el-text)">{chunks}</strong>,
        })}
      </span>

      {totalPages > 1 ? (
        <nav aria-label={t('pagination')} className="inline-flex items-center gap-1">
          <button
            type="button"
            aria-label={t('previousPage')}
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
                aria-label={t('page', { page: it })}
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
                aria-label={t('page', { page: it })}
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
            aria-label={t('nextPage')}
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
