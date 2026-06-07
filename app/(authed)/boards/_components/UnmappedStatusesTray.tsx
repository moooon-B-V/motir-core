'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

// The unmapped-statuses tray (Subtask 3.2.6 · design `board.mock.html` panel 5).
// Surfaces project workflow statuses mapped to NO board column
// (`BoardProjectionDto.unmappedStatuses`, Story 3.1.4 — the Jira behaviour). A
// yellow callout above the board names the statuses + links to the workflow
// admin (Story 2.2.5) to map them: work items in those statuses are HIDDEN from
// the board, never silently dropped. The caller renders this ONLY when
// `statuses` is non-empty (an empty tray never shows).
//
// Tokens: the yellow tint carries the hue in the BACKGROUND with
// `--el-text-strong` text (finding #35 AA — never a tinted page surface), and
// the warning triangle pairs the hue with a SHAPE so the signal is not
// colour-alone (finding #35). Status chips reuse the `Pill` neutral tone; shape
// via element tokens (`--radius-card`, `--spacing-control-*`).

export function UnmappedStatusesTray({ statuses }: { statuses: WorkflowStatusDto[] }) {
  const t = useTranslations('boards');
  return (
    <aside
      aria-label={t('unmappedLabel')}
      className="flex flex-wrap items-center gap-2.5 rounded-(--radius-card) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y)"
      data-testid="board-unmapped-tray"
    >
      <AlertTriangle className="h-[18px] w-[18px] shrink-0 text-(--el-warning)" aria-hidden />
      <span className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-(--el-text-strong)">
        {t('unmappedText')}
        <span className="inline-flex flex-wrap gap-1.5">
          {statuses.map((status) => (
            <Pill key={status.id} tone="neutral">
              {status.label}
            </Pill>
          ))}
        </span>
      </span>
      <Link
        href="/settings/project/workflow"
        className="text-sm font-semibold whitespace-nowrap text-(--el-link) hover:underline"
        data-testid="board-unmapped-link"
      >
        {t('unmappedMapColumns')} →
      </Link>
    </aside>
  );
}
