'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SearchX } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
import { buildBacklogFilterHref } from '@/lib/backlog/backlogFilterHref';

// The backlog region's FILTERED-EMPTY state (Story 8.8 · Subtask 8.8.18 · design
// backlog-filter.mock.html panel 4). When an active filter matches no item in the
// backlog region, it shows THIS — a distinct `EmptyState` ("No work items match
// this filter" + a search-x glyph + a Clear filter CTA) — NOT the 4.2
// brand-new-backlog empty state (which offers "Create work item"): the backlog is
// not empty, the FILTER is over-narrow, so the action is to clear it, not create.
// The active toolbar + the applied-filter summary row stay visible (they're
// rendered by the page, outside the region), so the user can see and edit what
// they filtered on. The board's BoardFilteredEmptyState (6.15.3), board → backlog.
//
// Clear returns to `/backlog` with no filter, reusing the same backlog-scoped href
// builder the filter controls navigate through.

export function BacklogFilteredEmptyState() {
  const t = useTranslations('backlog');
  return (
    <EmptyState
      icon={<SearchX className="h-12 w-12" aria-hidden />}
      title={t('filteredEmptyTitle')}
      description={t('filteredEmptyDescription')}
      data-testid="backlog-filtered-empty"
      action={
        <Link
          href={buildBacklogFilterHref({ filter: EMPTY_FILTER })}
          className="inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border border-(--el-border) px-3 font-sans text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {t('filteredEmptyClear')}
        </Link>
      }
    />
  );
}
