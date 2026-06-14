'use client';

import { useTranslations } from 'next-intl';
import { Bug } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils/cn';
import { useReport } from './ReportProvider';
import { useProjectAccess } from './ProjectAccessProvider';

/**
 * ReportButton — opens the in-app report widget (Subtask 6.11.7). Two entry
 * points share it via `useReport`: the global top-nav affordance (`display="shell"`,
 * the default) and the Triage inbox header (`display="inbox"`, the primary CTA
 * from `design/triage/` panel 1). Open state lives in ReportProvider.
 *
 * Hidden when there's no active project (`canReport` false) — a submission needs
 * a project. For a read-only actor (`canEdit` false, a viewer / a member on a
 * limited project) the affordance stays VISIBLE but disabled with a tooltip: the
 * 6.11.4 intake rejects a non-editor (403), so the submit path must not function,
 * but the affordance is shown blocked rather than absent — the 6.4.6 treatment,
 * mirroring CreateIssueButton.
 */
export function ReportButton({ display = 'shell' }: { display?: 'shell' | 'inbox' }) {
  const t = useTranslations('triage');
  const ta = useTranslations('projectAccess');
  const { openReport, canReport } = useReport();
  const { canEdit } = useProjectAccess();

  if (!canReport) return null;

  const label = t('widget.trigger');

  if (!canEdit) {
    return (
      <Tooltip content={ta('readOnlyHint')}>
        <span
          aria-disabled
          aria-label={label}
          className={cn(
            buttonVariants({ variant: display === 'inbox' ? 'primary' : 'ghost', size: 'sm' }),
            'text-(--el-text-faint) cursor-not-allowed opacity-60',
          )}
        >
          <Bug className="h-4 w-4" aria-hidden />
          <span className={display === 'inbox' ? undefined : 'hidden sm:inline'}>{label}</span>
        </span>
      </Tooltip>
    );
  }

  if (display === 'inbox') {
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

  // Shell affordance: a ghost button matching the top-nav action cluster; the
  // label collapses to icon-only below `sm` to save width next to the create /
  // search / theme / bell controls.
  return (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={<Bug className="h-4 w-4" />}
      onClick={openReport}
      aria-label={label}
    >
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}
