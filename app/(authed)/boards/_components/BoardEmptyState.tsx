'use client';

import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/EmptyState';
import { NewIssueButton } from '../../items/_components/NewIssueButton';

// The board-level empty state (Subtask 3.2.6 · design `board.mock.html` panel
// 6). A project with no work items shows this — an `EmptyState` (inbox icon +
// headline + copy) with a "New work item" CTA — instead of six blank columns.
// The CTA REUSES the shipped create flow via `NewIssueButton` (the same
// shell-level `CreateIssueProvider` modal the /items route uses — there is no
// second create path). `NewIssueButton` returns null when there's no active
// project, but the board never renders without one, so the CTA is always live
// here.
//
// Shown only when every column's `totalCount` is 0 AND there are no unmapped
// statuses — when statuses are unmapped, work items may exist in a hidden
// status, so the board keeps its columns + the unmapped tray rather than
// claiming "no work items" (see `BoardContainer`).

export function BoardEmptyState() {
  const t = useTranslations('boards');
  return (
    <EmptyState
      title={t('emptyTitle')}
      description={t('emptyDescription')}
      action={<NewIssueButton />}
      data-testid="board-empty"
    />
  );
}
