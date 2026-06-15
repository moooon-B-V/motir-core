'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SearchX } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
import { buildBoardFilterHref } from '@/lib/boards/boardFilterHref';

// The board's FILTERED-EMPTY state (Story 6.15 · Subtask 6.15.3 · design
// board-filter.mock.html panel 4). When an active filter matches no card, the
// board shows THIS — a distinct `EmptyState` ("No work items match this filter"
// + a search-x glyph + a Clear filter CTA) — NOT the 3.2 brand-new-board empty
// state (which offers "New work item"): the board is not empty, the FILTER is
// over-narrow, so the action is to clear it, not create. The active toolbar +
// the applied-filter summary row stay visible (they're rendered by the page,
// outside BoardContainer), so the user can see and edit what they filtered on.
//
// Clear returns to the board with no filter (the `?board=` selection preserved),
// reusing the same board-scoped href builder the filter controls navigate
// through.

export function BoardFilteredEmptyState({ selectedBoardId }: { selectedBoardId?: string }) {
  const t = useTranslations('boards');
  return (
    <EmptyState
      icon={<SearchX className="h-12 w-12" aria-hidden />}
      title={t('filteredEmptyTitle')}
      description={t('filteredEmptyDescription')}
      data-testid="board-filtered-empty"
      action={
        <Link
          href={buildBoardFilterHref({ boardId: selectedBoardId, filter: EMPTY_FILTER })}
          className="inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border border-(--el-border) px-3 font-sans text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {t('filteredEmptyClear')}
        </Link>
      }
    />
  );
}
