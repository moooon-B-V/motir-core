'use client';

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDownNarrowWide, ArrowUpNarrowWide } from 'lucide-react';
import { Segmented } from '@/components/ui/Segmented';
import type { MentionCandidate } from '@/components/ui/MarkdownEditor';
import type { CommentsPageDTO } from '@/lib/dto/comments';
import type { ActivityAllPageDto, ActivityHistoryPageDto } from '@/lib/dto/activity';
import type { StatusCategoryDto, WorkflowStatusDto } from '@/lib/dto/workflows';
import { useCommentsSort } from '@/lib/hooks/useCommentsSort';
import { DEFAULT_ACTIVITY_TAB, type ActivityTab } from '@/lib/activity/tab';
import { ContentSectionCard } from './ContentSectionCard';
import { CommentsSection } from './CommentsSection';
import { HistorySection } from './HistorySection';
import { AllSection } from './AllSection';
import { ActivitySkeleton } from './ActivityEntryRow';

// The completed Activity section (Story 5.5 · Subtask 5.5.4) — activates the
// filter seam 5.1.5 shipped disabled, per
// `design/work-items/activity-history.mock.html` panel 0: the segmented
// filter goes LIVE with three tabs — All / Comments / History (the Jira set
// minus Work log: no worklog feature), DEFAULT Comments (the Jira default) —
// and ONE sort toggle now governs every tab together (the verified cross-tab
// rule, JRACLOUD-73076), persisted per user exactly as 5.1.5 stores it (the
// shared `useCommentsSort` store — all three tabs read the same value).
//
// Tab choice is URL-driven (`?activity=all|comments|history`, the 2.5.8
// `?view=` house pattern): switching tabs replaces the URL, the server
// re-renders the page with the new tab's first cursor page, and this
// component shows the history-row skeleton while the transition is in
// flight. Each tab is its own section card sharing this header's controls:
// Comments stays exactly the 5.1.5 surface (untouched — only its header
// controls are swapped in); History and All are the new 5.5 feeds.

export interface ActivityCommentsProps {
  canComment: boolean;
  canModerate: boolean;
  currentUserId: string;
  currentUserName: string;
  mentionCandidates: MentionCandidate[];
}

export function ActivitySection({
  workItemId,
  tab,
  workflowStatuses,
  comments,
  initialComments,
  initialHistory,
  initialAll,
}: {
  workItemId: string;
  /** The active tab (parsed server-side from `?activity=`). */
  tab: ActivityTab;
  /** The project workflow's statuses — status-Pill tint resolution. */
  workflowStatuses: WorkflowStatusDto[];
  comments: ActivityCommentsProps;
  /** The active tab's server-rendered first page (the other two are null). */
  initialComments: CommentsPageDTO | null;
  initialHistory: ActivityHistoryPageDto | null;
  initialAll: ActivityAllPageDto | null;
}) {
  const t = useTranslations('activity');
  const tc = useTranslations('comments');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [order, setOrder] = useCommentsSort();
  const [isPending, startTransition] = useTransition();

  const statusCategories: Record<string, StatusCategoryDto> = {};
  for (const status of workflowStatuses) statusCategories[status.key] = status.category;

  function switchTab(next: ActivityTab) {
    const params = new URLSearchParams(searchParams);
    if (next === DEFAULT_ACTIVITY_TAB) params.delete('activity');
    else params.set('activity', next);
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  }

  // The 5.1.3 controls, generalised: the three-tab filter + the ONE sort
  // toggle every tab shares (flipping it re-orders Comments, History AND All
  // together — each tab reads the same store).
  const headerControls = (
    <div className="flex items-center gap-2">
      <Segmented
        label={tc('filterAria')}
        value={tab}
        onChange={switchTab}
        options={[
          { value: 'all' as ActivityTab, label: t('filterAll') },
          { value: 'comments' as ActivityTab, label: tc('filterComments') },
          { value: 'history' as ActivityTab, label: tc('filterHistory') },
        ]}
      />
      <button
        type="button"
        onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
        aria-label={order === 'asc' ? t('sortAriaOldest') : t('sortAriaNewest')}
        className="border-(--el-border) text-(--el-text-secondary) hover:text-(--el-text) inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-btn) border px-(--spacing-control-x) font-sans text-xs focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {order === 'asc' ? (
          <ArrowDownNarrowWide className="text-(--el-text-muted) h-3.5 w-3.5" aria-hidden />
        ) : (
          <ArrowUpNarrowWide className="text-(--el-text-muted) h-3.5 w-3.5" aria-hidden />
        )}
        {order === 'asc' ? tc('sortOldest') : tc('sortNewest')}
      </button>
    </div>
  );

  // A tab switch re-renders the page server-side; bridge the transition with
  // the history-row skeleton (panel 5) so the section doesn't jump.
  if (isPending) {
    return (
      <ContentSectionCard title={tc('title')} headerRight={headerControls}>
        <ActivitySkeleton rows={3} />
      </ContentSectionCard>
    );
  }

  if (tab === 'history') {
    return (
      <HistorySection
        workItemId={workItemId}
        initialPage={initialHistory}
        headerControls={headerControls}
        statusCategories={statusCategories}
      />
    );
  }

  if (tab === 'all') {
    return (
      <AllSection
        workItemId={workItemId}
        initialPage={initialAll}
        headerControls={headerControls}
        statusCategories={statusCategories}
        canComment={comments.canComment}
        canModerate={comments.canModerate}
        currentUserId={comments.currentUserId}
        mentionCandidates={comments.mentionCandidates}
      />
    );
  }

  return (
    <CommentsSection
      workItemId={workItemId}
      canComment={comments.canComment}
      canModerate={comments.canModerate}
      currentUserId={comments.currentUserId}
      currentUserName={comments.currentUserName}
      mentionCandidates={comments.mentionCandidates}
      initialPage={initialComments}
      headerControls={headerControls}
    />
  );
}
