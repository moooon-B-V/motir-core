import { forwardRef, type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

/**
 * Pill — compact status or severity label. Pure span, no interaction.
 *
 * Variant axes (use exactly one):
 *  - `status`: planned | in-progress | done — Prodect's Subtask lifecycle states.
 *  - `severity`: info | success | warning | danger — semantic UI states.
 *  - `memberRole`: admin | member | viewer — a project membership role
 *    (Story 6.4), one hued tint per role. (Named `memberRole`, not `role`, so
 *    it can't collide with the DOM `role` ARIA attribute on the span.)
 *  - `tone`: neutral — a non-semantic chip (counts, metadata). Dark text on a
 *    neutral surface.
 *
 * All tones use adaptive dark/light text (`--color-charcoal`) on a hued tint,
 * so every variant clears WCAG AA contrast in both light and dark modes
 * (the hue lives in the background, not the text — PRODECT_FINDINGS #35).
 *
 * Always uses `--radius-badge` for fully rounded ends regardless of display style.
 *
 * @example
 * <Pill status="in-progress">In progress</Pill>
 * <Pill severity="danger">Validation failed</Pill>
 * <Pill tone="neutral">3 members</Pill>
 */
const pillVariants = cva(
  cn(
    'inline-flex items-center gap-1',
    'rounded-(--radius-badge)',
    'px-(--spacing-chip-x) py-(--spacing-chip-y)',
    'font-sans text-xs font-medium',
    'border',
  ),
  {
    variants: {
      // All colored tones carry the semantic hue in the TINT BACKGROUND and use
      // adaptive dark/light TEXT (`--color-charcoal`: #37352f light, #e5e5e5
      // dark) — the same pattern `planned` always used. The previous saturated
      // hue-on-tint TEXT failed WCAG AA (≈2.5–3.8:1 light, 3.2–4.0:1 dark);
      // charcoal-on-tint clears ~10:1 in both modes (PRODECT_FINDINGS #35).
      status: {
        planned: 'bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent',
        'in-progress': 'bg-(--el-tint-sky) text-(--el-text-strong) border-transparent',
        done: 'bg-(--el-tint-mint) text-(--el-text-strong) border-transparent',
      },
      severity: {
        info: 'bg-(--el-tint-sky) text-(--el-text-strong) border-transparent',
        success: 'bg-(--el-tint-mint) text-(--el-text-strong) border-transparent',
        warning: 'bg-(--el-tint-peach) text-(--el-text-strong) border-transparent',
        danger: 'bg-(--el-tint-rose) text-(--el-text-strong) border-transparent',
      },
      // Project membership roles (Story 6.4 · design/projects access-members):
      // admin → lavender, member → sky, viewer → mint — the hue in the tint,
      // charcoal text (AA-safe, finding #35), same recipe as `status`.
      memberRole: {
        admin: 'bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent',
        member: 'bg-(--el-tint-sky) text-(--el-text-strong) border-transparent',
        viewer: 'bg-(--el-tint-mint) text-(--el-text-strong) border-transparent',
      },
      tone: {
        neutral: 'bg-(--el-surface) text-(--el-text-secondary) border-(--el-border)',
      },
    },
    defaultVariants: {},
  },
);

export interface PillProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof pillVariants> {}

export const Pill = forwardRef<HTMLSpanElement, PillProps>(function Pill(
  { status, severity, memberRole, tone, className, children, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(pillVariants({ status, severity, memberRole, tone }), className)}
      {...rest}
    >
      {children}
    </span>
  );
});
