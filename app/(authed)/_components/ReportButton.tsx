'use client';

import { useTranslations } from 'next-intl';
import { Bug } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils/cn';
import { useReport } from './ReportProvider';
import { useProjectAccess } from './ProjectAccessProvider';

/**
 * ReportButton — opens the in-app report widget (Subtask 6.11.7). Two entry
 * points share it via `useReport`:
 *
 *   - `display="shell"` (default): the global top-nav affordance. An ICON button
 *     living in the icon cluster (alongside the theme toggle + notification
 *     bell), NOT a third bordered text button next to Create/Search — that
 *     crowded the bar. Mirrors NotificationBell's token-correct icon-button
 *     grammar (`--radius-control` + `--spacing-icon-btn`).
 *   - `display="inbox"`: the Triage inbox header CTA — the primary "Report"
 *     button from `design/triage/` panel 1.
 *
 * Open state lives in ReportProvider. Hidden when there's no active project
 * (`canReport` false). For a read-only actor (`canEdit` false) the affordance
 * stays VISIBLE but disabled with a tooltip: the 6.11.4 intake rejects a
 * non-editor (403), so the submit path must not function, but the affordance is
 * shown blocked rather than absent — the 6.4.6 treatment, like CreateIssueButton.
 */
const ICON_BTN =
  'inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)';

export function ReportButton({ display = 'shell' }: { display?: 'shell' | 'inbox' }) {
  const t = useTranslations('triage');
  const ta = useTranslations('projectAccess');
  const { openReport, canReport } = useReport();
  const { canEdit } = useProjectAccess();

  if (!canReport) return null;

  const label = t('widget.trigger');

  // The inbox-header CTA: the design's primary text button. This page already
  // gates on canEdit, so the disabled branch never shows there.
  if (display === 'inbox') {
    if (!canEdit) {
      return (
        <Tooltip content={ta('readOnlyHint')}>
          <span
            aria-disabled
            aria-label={label}
            className={cn(
              'inline-flex h-(--height-btn-sm) cursor-not-allowed items-center gap-2 rounded-(--radius-btn) bg-(--el-accent) px-3 text-xs font-medium text-(--el-accent-text) opacity-50',
            )}
          >
            <Bug className="h-4 w-4" aria-hidden />
            {label}
          </span>
        </Tooltip>
      );
    }
    return (
      <Button
        variant="primary"
        size="sm"
        leftIcon={<Bug className="h-4 w-4" />}
        onClick={openReport}
      >
        {label}
      </Button>
    );
  }

  // The shell affordance: a token-correct icon button (Bug) with a tooltip,
  // grouped with the other top-nav icon controls.
  if (!canEdit) {
    return (
      <Tooltip content={ta('readOnlyHint')}>
        <span
          aria-disabled
          aria-label={label}
          className={cn(ICON_BTN, 'cursor-not-allowed text-(--el-text-faint) opacity-60')}
        >
          <Bug className="h-5 w-5" aria-hidden />
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={openReport}
        aria-label={label}
        className={cn(
          ICON_BTN,
          'text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text)',
        )}
      >
        <Bug className="h-5 w-5" aria-hidden />
      </button>
    </Tooltip>
  );
}
