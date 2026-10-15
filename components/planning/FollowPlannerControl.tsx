'use client';

import { useTranslations } from 'next-intl';
import { Navigation } from 'lucide-react';

// THE FOLLOW CONTROL on the planning overlay's canvas bar (Story MOTIR-8590 ·
// Subtask MOTIR-8594; design `design/ai-planning/design-notes.md` Part XXVIII
// §28.3 Table A, §28.5, §28.7, §28.8; `plan-review--follow-the-planner.mock.html`).
//
// ON is a STATUS, not a toggle: while following, moving the canvas already turns
// it off, so the only thing a control could offer is redundant. OFF is the button.
// Both use the lucide `navigation` glyph (`locate-fixed` is the canvas's own Locate
// control). Below a 32rem pane the label goes `sr-only` and the button becomes a
// `--height-control` square named by `aria-label` + `title`; the label is never
// truncated. It reads the pane's width from the host's `@container/plan-pane`.
//
// It decides nothing: following, idleness and leaving are the host's.

export interface FollowPlannerControlProps {
  /** Following is ON: the quiet status. OFF: the *Follow the planner* button. */
  following: boolean;
  /** Stalled, or the poll failing: armed but idle, so the glyph drops to faint. */
  idle?: boolean;
  /** The plan just left `generating`: the control plays its leaving fade. */
  leaving?: boolean;
  /** The leaving fade ended. */
  onLeft?: () => void;
  onFollow: () => void;
}

const COMPACT_LABEL = '@max-[32rem]/plan-pane:sr-only';
const LEAVE =
  'motion-safe:animate-[canvas-fade-out_var(--transition-fast)_var(--canvas-ease-exit)_forwards] motion-reduce:hidden';

export function FollowPlannerControl({
  following,
  idle = false,
  leaving = false,
  onLeft,
  onFollow,
}: FollowPlannerControlProps) {
  const t = useTranslations('planningWorkspace.follow');
  // The faint idle glyph is decorative (`aria-hidden`), the one use the token allows.
  const glyph = (
    <Navigation
      aria-hidden="true"
      className={`size-3.5 shrink-0 ${idle ? 'text-(--el-text-faint)' : 'text-(--el-accent-on-surface)'}`}
    />
  );
  const leave = leaving ? LEAVE : '';
  const onAnimationEnd = leaving ? () => onLeft?.() : undefined;

  if (following) {
    return (
      <span
        data-testid="canvas-follow-state"
        data-follow="on"
        data-idle={idle || undefined}
        data-leaving={leaving || undefined}
        onAnimationEnd={onAnimationEnd}
        className={`inline-flex shrink-0 items-center gap-1.5 px-(--spacing-control-x) py-(--spacing-control-y) text-xs text-(--el-text-secondary) ${leave}`}
      >
        {glyph}
        <span className={COMPACT_LABEL}>{t('following')}</span>
      </span>
    );
  }
  const label = t('resume');
  return (
    <button
      type="button"
      data-testid="canvas-follow-planner"
      data-follow="off"
      data-idle={idle || undefined}
      data-leaving={leaving || undefined}
      onAnimationEnd={onAnimationEnd}
      onClick={onFollow}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-card) px-(--spacing-control-x) py-(--spacing-control-y) text-xs text-(--el-text-secondary) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) @max-[32rem]/plan-pane:size-(--height-control) @max-[32rem]/plan-pane:justify-center @max-[32rem]/plan-pane:p-0 ${leave}`}
    >
      {glyph}
      <span className={COMPACT_LABEL}>{label}</span>
    </button>
  );
}
