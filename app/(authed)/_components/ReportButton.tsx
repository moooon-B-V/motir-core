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
 *     grammar (`--radius-control` + a `--height-control` square box). It is
 *     `hidden md:inline-flex`: MOTIR-2373 DISPLACED it from the below-`md` bar,
 *     because it has no ⌘K action and `/triage`'s inbox CTA is a different act
 *     (reporting from the queue, not about the screen you are on) — so it needed
 *     a drawn home, not a citation.
 *   - `display="drawer"`: that drawn home — the SAME icon button, re-homed in
 *     `SidebarDrawer`'s utility strip, without the `md` gate. Not a new
 *     component: it is the element that left the bar.
 *   - `display="inbox"`: the Triage inbox header CTA — the primary "Report"
 *     button from `design/triage/` panel 1.
 *
 * Open state lives in ReportProvider. Hidden when there's no active project
 * (`canReport` false). For a read-only actor (`canEdit` false) the affordance
 * stays VISIBLE but disabled with a tooltip: the 6.11.4 intake rejects a
 * non-editor (403), so the submit path must not function, but the affordance is
 * shown blocked rather than absent — the 6.4.6 treatment, like CreateIssueButton.
 */
// The shell/drawer icon box, WITHOUT a display utility — the caller's placement
// selects it. `.hidden` and `.inline-flex` have equal specificity, so appending
// the gate to a class string that already carries `inline-flex` leaves the
// winner up to Tailwind's emission order; selecting one is deterministic.
const ICON_BTN =
  'items-center justify-center rounded-(--radius-control) h-(--height-control) w-(--height-control) transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)';

export function ReportButton({ display = 'shell' }: { display?: 'shell' | 'inbox' | 'drawer' }) {
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
  // grouped with the other top-nav icon controls — `md`-and-up in the bar, and
  // unconditional inside the drawer's utility strip.
  const displayUtility = display === 'drawer' ? 'inline-flex' : 'hidden md:inline-flex';

  if (!canEdit) {
    return (
      <Tooltip content={ta('readOnlyHint')}>
        <span
          aria-disabled
          aria-label={label}
          className={cn(
            ICON_BTN,
            displayUtility,
            'cursor-not-allowed text-(--el-text-faint) opacity-60',
          )}
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
          displayUtility,
          'text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text)',
        )}
      >
        <Bug className="h-5 w-5" aria-hidden />
      </button>
    </Tooltip>
  );
}
