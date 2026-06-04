import { Pill } from './Pill';
import { cn } from '@/lib/utils/cn';

// ReadinessBadge — the ready / blocked indicator for a work item (Subtask
// 2.4.5, the presentational face of `workflowsService` / 2.2.6's readiness
// verdict). PURE: it takes the already-computed verdict (`ready` + the open
// blockers' identifiers) and renders it; it does NOT re-derive readiness (the
// service owns the per-project terminal classification — finding #21). This is
// the SAME primitive Epic 3 boards + Epic 6 reports reuse, so it stays a small
// span-level component with no page coupling.
//
// State is conveyed by TEXT ("Ready" / "Blocked"), never colour alone, so it
// clears the shell-a11y axe sweep (the hue rides the Pill tint as a redundant
// cue). When blocked, the open blockers are NAMED inline so the reason is
// legible ("Blocked by PROD-3, PROD-12") — the caller passes the identifiers it
// already resolved; an empty/omitted list just renders the bare "Blocked" pill
// (the board-card reuse, where space is tight).

export interface ReadinessBadgeProps {
  /** The service verdict: true iff every blocker is terminal (or none exist). */
  ready: boolean;
  /**
   * Identifiers of the OPEN (non-terminal) blockers, named after the pill when
   * blocked. Omit/empty for a bare "Blocked" pill (e.g. a dense board card).
   */
  blockers?: string[];
  className?: string;
}

export function ReadinessBadge({ ready, blockers = [], className }: ReadinessBadgeProps) {
  if (ready) {
    return (
      <Pill severity="success" className={className}>
        Ready
      </Pill>
    );
  }

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-2 gap-y-1', className)}>
      <Pill severity="warning">Blocked</Pill>
      {blockers.length > 0 ? (
        <span className="font-sans text-xs text-(--el-text-secondary)">
          by {blockers.join(', ')}
        </span>
      ) : null}
    </span>
  );
}
