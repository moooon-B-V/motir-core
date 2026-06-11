'use client';

import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { TriangleAlert, X } from 'lucide-react';
import { buildIssueListHref, type IssueListView, type IssueSort } from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';

// The invalid `?filter=` recovery state (Subtask 6.1.4), per
// design/work-items/filter-builder.mock.html panel 6: a malformed, forged, or
// newer-versioned param decodes to the TYPED recoverable failure (the 6.1.1
// codec contract), which renders this callout card (`role="alert"`) above the
// UNFILTERED list — never a crash, never a silent drop. "Clear filter"
// navigates to the canonical URL without the param (the page already nulled
// `filter.advanced` before threading, so view/sort/facets are preserved).

export interface InvalidFilterCalloutProps {
  view: IssueListView;
  sort: IssueSort;
  /** The threaded filter (advanced already nulled by the page). */
  filter: IssueFilter;
}

export function InvalidFilterCallout({ view, sort, filter }: InvalidFilterCalloutProps) {
  const t = useTranslations('issueViews');
  const router = useRouter();
  const pathname = usePathname();
  return (
    <div
      role="alert"
      className="flex max-w-[560px] items-start gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-4 py-3.5"
    >
      <TriangleAlert className="mt-px h-[18px] w-[18px] shrink-0 text-(--el-warning)" aria-hidden />
      <div>
        <h2 className="text-sm font-semibold text-(--el-text)">{t('advancedInvalidTitle')}</h2>
        <p className="mt-0.5 mb-2.5 text-[13px] leading-relaxed text-(--el-text-secondary)">
          {t('advancedInvalidDescription')}
        </p>
        <button
          type="button"
          onClick={() => router.push(buildIssueListHref(pathname, { view, sort, filter }))}
          className="inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border border-(--el-border) px-3 font-sans text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <X className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
          {t('advancedClearFilter')}
        </button>
      </div>
    </div>
  );
}
