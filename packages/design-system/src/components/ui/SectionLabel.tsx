import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils/cn';

/**
 * SectionLabel — the small uppercase-mono header that captions a group of
 * rows (a sidebar nav section, and later the cmd-K command groups).
 *
 * Lifted to its own primitive per PRODECT_FINDINGS #28 so the two consumers
 * share ONE source of truth for the canonical typography (mono · 11px ·
 * semibold · uppercase · 0.06em tracking · muted-foreground) instead of each
 * memorizing four utility classes. `Sidebar` uses it for section labels now;
 * 1.5.4's `CommandGroupHeader` composes the same primitive.
 *
 * Presentational only — renders a `<div>`. Pass `label` for the common
 * string case, or `children` for richer content (e.g. a label + a count).
 *
 * @example
 * <SectionLabel label="Workspace" />
 * <SectionLabel>Results <span>{count}</span></SectionLabel>
 */
export interface SectionLabelProps extends HTMLAttributes<HTMLDivElement> {
  /** Convenience for the string case; ignored when `children` is provided. */
  label?: string;
  children?: ReactNode;
}

export const SectionLabel = forwardRef<HTMLDivElement, SectionLabelProps>(function SectionLabel(
  { label, children, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-(--el-text-eyebrow)',
        className,
      )}
      {...rest}
    >
      {children ?? label}
    </div>
  );
});
