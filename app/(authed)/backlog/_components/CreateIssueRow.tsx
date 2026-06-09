'use client';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

// The inline "+ Create issue" row (Story 4.2). PLACED in Subtask 4.2.3 (the read
// render) and WIRED in Subtask 4.2.5 (`createBacklogIssue` — create into the
// backlog or directly into a sprint). Disabled here, matching the established
// seam pattern (the boards page's disabled `[Filter]` button), so the layout is
// final and 4.2.5 only swaps the handler in.

export function CreateIssueRow() {
  const t = useTranslations('backlog');
  return (
    <button
      type="button"
      disabled
      title={t('createIssueComingSoon')}
      className="flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-text-muted) disabled:opacity-60"
    >
      <Plus className="h-4 w-4 shrink-0" aria-hidden />
      {t('createIssue')}
    </button>
  );
}
