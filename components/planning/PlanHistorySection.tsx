'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, CircleAlert, History, MessagesSquare } from 'lucide-react';

import { Spinner } from '@/components/ui/Spinner';
import { usePlanHistory } from '@/lib/hooks/usePlanHistory';
import { cn } from '@/lib/utils/cn';

import { PlanHistoryRow } from '@/components/planning/PlanHistoryRow';

// THE OVERLAY'S HISTORY (Story MOTIR-9218 · MOTIR-9307; design MOTIR-9305,
// `design/ai-chat/planning-workspace--history.mock.html`): a collapsible section
// under the rail head listing the viewer's OWN conversations in this project,
// newest activity first. Collapsed on every overlay open and fetching nothing
// until it is first expanded; ten rows a page, the next page asked for when the
// bottom of the list scrolls into view (or its last row takes focus).
//
// A row only CALLS `onOpenSession`: switching the overlay to that session is the
// host's (MOTIR-9308).

const ROW_SKELETONS = 3;

export interface PlanHistorySectionProps {
  /** The session the overlay shows now — its row carries the current marker. */
  currentSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
}

export function PlanHistorySection({ currentSessionId, onOpenSession }: PlanHistorySectionProps) {
  const t = useTranslations('planningWorkspace.history');
  const ts = useTranslations('aiPlanning.sessions');
  const [expanded, setExpanded] = useState(false);
  const { rows, status, failedPage, loadMore, retry } = usePlanHistory(expanded);
  const regionId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);

  // The bottom of the list coming into view asks for the next page. The LIST is the
  // observer's root: it scrolls on its own inside the rail.
  useEffect(() => {
    const root = listRef.current;
    const sentinel = sentinelRef.current;
    if (!expanded || status !== 'ready' || !root || !sentinel) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { root },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [expanded, status, loadMore]);

  const retryButton = (
    <button
      type="button"
      data-testid="planning-history-retry"
      onClick={retry}
      className="ml-auto rounded-(--radius-control) text-xs font-medium text-(--el-link) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      {ts('loadMoreRetry')}
    </button>
  );

  const firstLoading = status === 'loadingFirst';
  const firstFailed = status === 'error' && failedPage === 'first';
  const empty = status === 'done' && rows.length === 0;

  return (
    <section
      aria-label={t('header')}
      data-testid="planning-history"
      className="flex-none border-b border-(--el-border-soft)"
    >
      <button
        type="button"
        data-testid="planning-history-toggle"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded((open) => !open)}
        className="flex h-(--height-control) w-full items-center gap-2 px-(--spacing-control-x-16) text-left text-[13px] font-semibold text-(--el-text) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:ring-inset"
      >
        <ChevronRight
          className={cn(
            'size-3.5 flex-none text-(--el-text-secondary) transition-transform motion-reduce:transition-none',
            expanded && 'rotate-90',
          )}
          aria-hidden
        />
        <History className="size-3.5 flex-none text-(--el-text-secondary)" aria-hidden />
        <span>{t('header')}</span>
      </button>

      {expanded ? (
        <div id={regionId}>
          {firstLoading ? (
            <div data-testid="planning-history-skeleton" className="flex flex-col px-2 pb-2">
              <span role="status" className="sr-only">
                {t('loading')}
              </span>
              {Array.from({ length: ROW_SKELETONS }, (_, i) => (
                <span
                  key={i}
                  aria-hidden="true"
                  className="flex flex-col gap-1.5 px-(--spacing-control-x-8) py-(--spacing-control-y-8)"
                >
                  <span className="h-2.5 w-4/5 animate-pulse rounded-(--radius-control) bg-(--el-muted) motion-reduce:animate-none" />
                  <span className="h-2.5 w-1/2 animate-pulse rounded-(--radius-control) bg-(--el-muted) motion-reduce:animate-none" />
                </span>
              ))}
            </div>
          ) : firstFailed ? (
            <div
              role="alert"
              data-testid="planning-history-error"
              className="flex items-center gap-2 px-(--spacing-control-x-16) py-(--spacing-control-y-8) text-xs text-(--el-text)"
            >
              <CircleAlert
                className="size-3.5 flex-none text-(--el-danger-on-surface)"
                aria-hidden
              />
              <span>{t('error')}</span>
              {retryButton}
            </div>
          ) : empty ? (
            <div
              data-testid="planning-history-empty"
              className="flex flex-col items-center gap-1 px-6 pt-3.5 pb-4.5 text-center"
            >
              <MessagesSquare className="size-4 text-(--el-text-secondary)" aria-hidden />
              <b className="text-[13px] font-semibold text-(--el-text)">{t('emptyTitle')}</b>
              <span className="text-xs text-(--el-text-secondary)">{t('emptyBody')}</span>
            </div>
          ) : (
            <ul
              ref={listRef}
              aria-label={t('regionAria')}
              data-testid="planning-history-list"
              className="flex max-h-75 list-none flex-col gap-0.5 overflow-y-auto px-2 pb-2"
            >
              {rows.map((session, i) => (
                <PlanHistoryRow
                  key={session.id}
                  session={session}
                  current={session.id === currentSessionId}
                  onOpen={onOpenSession}
                  onFocusLast={i === rows.length - 1 ? loadMore : undefined}
                />
              ))}
              {status === 'loadingMore' ? (
                <li
                  role="status"
                  data-testid="planning-history-loading-more"
                  className="flex items-center justify-center gap-2 px-(--spacing-control-x-8) py-(--spacing-control-y-8) text-xs text-(--el-text-secondary)"
                >
                  <Spinner size="sm" aria-hidden="true" />
                  <span>{t('loadingMore')}</span>
                </li>
              ) : null}
              {status === 'error' && failedPage === 'next' ? (
                <li
                  role="alert"
                  data-testid="planning-history-error"
                  className="flex items-center gap-2 px-(--spacing-control-x-8) py-(--spacing-control-y-8) text-xs text-(--el-text)"
                >
                  <CircleAlert
                    className="size-3.5 flex-none text-(--el-danger-on-surface)"
                    aria-hidden
                  />
                  <span>{ts('loadMoreError')}</span>
                  {retryButton}
                </li>
              ) : null}
              {status === 'done' ? (
                <li
                  data-testid="planning-history-end"
                  className="flex items-center gap-2 px-(--spacing-control-x-8) pt-1.5 pb-0.5 text-xs text-(--el-text-secondary)"
                >
                  <span className="h-px flex-1 bg-(--el-border-soft)" aria-hidden="true" />
                  <span>{t('end')}</span>
                  <span className="h-px flex-1 bg-(--el-border-soft)" aria-hidden="true" />
                </li>
              ) : null}
              <li ref={sentinelRef} aria-hidden="true" className="h-px flex-none" />
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
