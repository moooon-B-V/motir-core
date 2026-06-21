'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { History } from 'lucide-react';
import { ErrorState } from '@/components/ui/ErrorState';
import type { ActivityEntryDto, ActivityHistoryPageDto } from '@/lib/dto/activity';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { useCommentsSort } from '@/lib/hooks/useCommentsSort';
import { ContentSectionCard } from './ContentSectionCard';
import { ActivityEntryRow, ActivitySkeleton } from './ActivityEntryRow';

// The History tab (Story 5.5 · Subtask 5.5.4) — the read surface over the
// append-only `work_item_revision` trail, per
// `design/work-items/activity-history.mock.html` panels 0/4/5: cursor-paged
// entries (20/page, finding #57) with "Show more changes (N older)" at the
// OLDER edge, the count gloss, the shared per-user sort order, the
// history-row skeleton / empty / ErrorState grammars. READ-ONLY for every
// role — no entry carries any affordance (append-only, the verified Jira
// rule).
//
// Like CommentsSection, the window is HELD newest-first (the fetch walk is
// always `order=desc`; the cursor extends backward) and the sort order is a
// presentation flip of the loaded window — the 5.1.5 panel-6 contract,
// generalised to the section by the one shared store.

export function HistorySection({
  workItemId,
  initialPage,
  headerControls,
  statusCategories,
}: {
  workItemId: string;
  /** The server-rendered first page, or null when the server read failed —
   * the section then renders ErrorState + retry. */
  initialPage: ActivityHistoryPageDto | null;
  /** The shared Activity filter + sort toggle (owned by ActivitySection). */
  headerControls: ReactNode;
  statusCategories: Readonly<Record<string, StatusCategoryDto>>;
}) {
  const t = useTranslations('activity');
  const tc = useTranslations('comments');

  const [entries, setEntries] = useState<ActivityEntryDto[]>(initialPage?.entries ?? []);
  const [totalCount, setTotalCount] = useState(initialPage?.totalCount ?? 0);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage?.nextCursor ?? null);
  const [order] = useCommentsSort();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(initialPage === null);

  async function fetchPage(cursor?: string): Promise<ActivityHistoryPageDto> {
    const params = new URLSearchParams({ order: 'desc' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/work-items/${workItemId}/activity/history?${params}`);
    if (!res.ok) throw new Error(`History read failed (${res.status})`);
    return (await res.json()) as ActivityHistoryPageDto;
  }

  function retryInitial() {
    setFailed(false);
    setLoading(true);
    void fetchPage()
      .then((page) => {
        setEntries(page.entries);
        setTotalCount(page.totalCount);
        setNextCursor(page.nextCursor);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }

  // "Show more changes (N older)" — extend the window backward; in
  // oldest-first display the extension renders ABOVE, so compensate the
  // scroll position by the added height (the CommentsSection mechanic).
  function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const scroller = document.scrollingElement;
    const prevHeight = scroller?.scrollHeight ?? 0;
    void fetchPage(nextCursor)
      .then((page) => {
        setEntries((current) => [...current, ...page.entries]);
        setTotalCount(page.totalCount);
        setNextCursor(page.nextCursor);
        if (order === 'asc' && scroller) {
          requestAnimationFrame(() => {
            scroller.scrollTop += scroller.scrollHeight - prevHeight;
          });
        }
      })
      .catch(() => setFailed(true))
      .finally(() => setLoadingMore(false));
  }

  const olderCount = Math.max(0, totalCount - entries.length);
  const displayEntries = order === 'asc' ? [...entries].reverse() : entries;
  const empty = !failed && !loading && totalCount === 0 && entries.length === 0;

  const showMore =
    nextCursor && !failed ? (
      <button
        type="button"
        onClick={loadMore}
        disabled={loadingMore}
        className="border-(--el-border-strong) bg-(--el-surface-soft) text-(--el-text-secondary) hover:text-(--el-text) h-(--height-control) w-full rounded-(--radius-control) border border-dashed px-(--spacing-control-x) font-sans text-xs focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        {t('showMoreChanges', { count: olderCount })}
      </button>
    ) : null;

  const olderEdgeSkeleton = loadingMore ? <ActivitySkeleton rows={2} /> : null;

  return (
    <ContentSectionCard
      title={tc('title')}
      subtitle={failed ? undefined : t('changesGloss', { count: totalCount })}
      headerRight={headerControls}
    >
      {failed ? (
        <ErrorState
          title={t('errorHistoryTitle')}
          description={t('errorDescription')}
          retry={retryInitial}
        />
      ) : loading ? (
        <ActivitySkeleton rows={3} />
      ) : empty ? (
        <div className="flex flex-col items-center gap-1.5 py-6">
          <History className="text-(--el-text-faint) h-[22px] w-[22px]" aria-hidden />
          <p className="text-(--el-text-secondary) font-sans text-sm">{t('emptyHistory')}</p>
        </div>
      ) : (
        <ul aria-label={t('historyAria')} className="flex list-none flex-col gap-3.5">
          {/* The OLDER edge — top in oldest-first display (panel 4). */}
          {order === 'asc' ? (
            <>
              {showMore ? <li>{showMore}</li> : null}
              {olderEdgeSkeleton ? <li>{olderEdgeSkeleton}</li> : null}
            </>
          ) : null}
          {displayEntries.map((entry) =>
            entry.parts.map((part, partIndex) => (
              <li key={`${entry.id}:${partIndex}`}>
                <ActivityEntryRow entry={entry} part={part} statusCategories={statusCategories} />
              </li>
            )),
          )}
          {/* The OLDER edge — bottom in newest-first display (panel 4). */}
          {order === 'desc' ? (
            <>
              {olderEdgeSkeleton ? <li>{olderEdgeSkeleton}</li> : null}
              {showMore ? <li>{showMore}</li> : null}
            </>
          ) : null}
        </ul>
      )}
    </ContentSectionCard>
  );
}
