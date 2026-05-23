import { forwardRef, type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

/**
 * Pill — compact status or severity label. Pure span, no interaction.
 *
 * Two variant axes (use one or the other, not both):
 *  - `status`: planned | in-progress | done — Prodect's Subtask lifecycle states.
 *  - `severity`: info | success | warning | danger — semantic UI states.
 *
 * Always uses `--radius-badge` for fully rounded ends regardless of display style.
 *
 * @example
 * <Pill status="in-progress">In progress</Pill>
 * <Pill severity="danger">Validation failed</Pill>
 */
const pillVariants = cva(
  cn(
    'inline-flex items-center gap-1',
    'rounded-(--radius-badge)',
    'px-2.5 py-0.5',
    'font-sans text-xs font-medium',
    'border',
  ),
  {
    variants: {
      status: {
        planned: 'bg-(--color-tint-lavender) text-(--color-charcoal) border-transparent',
        'in-progress': 'bg-(--color-tint-sky) text-(--color-info) border-transparent',
        done: 'bg-(--color-tint-mint) text-(--color-success) border-transparent',
      },
      severity: {
        info: 'bg-(--color-tint-sky) text-(--color-info) border-transparent',
        success: 'bg-(--color-tint-mint) text-(--color-success) border-transparent',
        warning: 'bg-(--color-tint-peach) text-(--color-warning) border-transparent',
        danger: 'bg-(--color-tint-rose) text-(--color-destructive) border-transparent',
      },
    },
    defaultVariants: {},
  },
);

export interface PillProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof pillVariants> {}

export const Pill = forwardRef<HTMLSpanElement, PillProps>(function Pill(
  { status, severity, className, children, ...rest },
  ref,
) {
  return (
    <span ref={ref} className={cn(pillVariants({ status, severity }), className)} {...rest}>
      {children}
    </span>
  );
});
