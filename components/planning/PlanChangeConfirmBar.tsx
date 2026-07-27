'use client';

import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import type { PlanChangeDiffIndex } from '@/lib/planning/planChangeDiff';

// The CONFIRM-TO-PERSIST bar under the plan-change canvas (Subtask MOTIR-1730;
// design panel 4's `persistbar`, composed unchanged from
// `planning-workspace.mock.html` sheets 2 + 6 — only the copy names the
// add / change counts).
//
// It is the GATE: nothing the conversation proposed has reached the database, and
// this is where that becomes true (Approve) or is dropped (Discard, which writes
// nothing). After EITHER, the conversation stays open — the bar simply goes away
// with the proposal, and the rail keeps the thread.

export interface PlanChangeConfirmBarProps {
  index: PlanChangeDiffIndex;
  approving: boolean;
  onApprove: () => void;
  onDiscard: () => void;
}

export function PlanChangeConfirmBar({
  index,
  approving,
  onApprove,
  onDiscard,
}: PlanChangeConfirmBarProps) {
  const t = useTranslations('planningWorkspace.conversation');

  return (
    <div
      data-testid="plan-change-confirm-bar"
      className="flex shrink-0 items-center gap-3 border-t border-(--el-border) bg-(--el-surface) px-4 py-2.5"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-semibold text-(--el-text)">
          {t('barCounts', { added: index.counts.added, changed: index.counts.changed })}
        </span>
        <span className="truncate text-xs text-(--el-text-muted)">{t('barNothingSaved')}</span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {approving ? <Spinner size="sm" aria-hidden="true" /> : null}
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={approving}>
          {t('discard')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Check className="size-4" aria-hidden="true" />}
          onClick={onApprove}
          disabled={approving}
        >
          {t('approveChanges')}
        </Button>
      </div>
    </div>
  );
}
