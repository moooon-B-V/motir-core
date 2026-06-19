import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

/**
 * Card — content container with optional header/footer slots and tint variants.
 *
 * Compose with `header` / `footer` props for the common pattern, or just
 * pass children for a bare card. `clickable` makes the whole card a button
 * (use `onClick` + Enter/Space; pass `href` to render as `<a>` instead).
 *
 * Tint variants use the pastel feature tints from the palette
 * (peach/rose/mint/lavender/sky/yellow) — apply sparingly, never to
 * page-level surfaces.
 *
 * @example
 * <Card header={<h3>Title</h3>}>Body content</Card>
 * <Card tint="lavender" clickable onClick={open}>Pastel card</Card>
 * <Card tint="mint"><a href="/x">Link wrapper</a></Card>
 */
const cardVariants = cva(
  cn(
    'rounded-(--radius-card) border border-(--el-border)',
    'p-(--spacing-card-padding)',
    'transition-shadow duration-(--transition-duration)',
  ),
  {
    variants: {
      tint: {
        none: 'bg-(--el-page-bg)',
        peach: 'bg-(--el-tint-peach) border-transparent',
        rose: 'bg-(--el-tint-rose) border-transparent',
        mint: 'bg-(--el-tint-mint) border-transparent',
        lavender: 'bg-(--el-tint-lavender) border-transparent',
        sky: 'bg-(--el-tint-sky) border-transparent',
        yellow: 'bg-(--el-tint-yellow) border-transparent',
      },
      clickable: {
        true: 'cursor-pointer hover:shadow-(--shadow-card) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        false: '',
      },
    },
    defaultVariants: { tint: 'none', clickable: false },
  },
);

export interface CardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'children'>, VariantProps<typeof cardVariants> {
  header?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { tint, clickable, header, footer, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(cardVariants({ tint, clickable }), className)}
      // `data-tilt` is the hook the 3D / Immersive style's pointer-parallax
      // engine (ImmersiveTilt, 7.3.39) uses to tip this tile toward the cursor.
      // Inert for every other style + under reduced motion; harmless otherwise.
      data-tilt=""
      // `data-surface` is the hook a surface-MATERIAL style (e.g. glassmorphism)
      // uses to frost this panel — see globals.css's material layer. Only the
      // default (untinted) card opts in; a pastel-tint feature card keeps its
      // opaque tint, never a frosted overlay that would wash the hue out.
      {...(tint && tint !== 'none' ? {} : { 'data-surface': 'card' })}
      {...(clickable ? { tabIndex: 0, role: 'button' } : {})}
      {...rest}
    >
      {header ? <div className="mb-(--spacing-md)">{header}</div> : null}
      <div>{children}</div>
      {footer ? (
        <div className="border-(--el-border) mt-(--spacing-md) border-t pt-(--spacing-md)">
          {footer}
        </div>
      ) : null}
    </div>
  );
});
