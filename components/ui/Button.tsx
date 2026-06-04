import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Spinner } from './Spinner';
import { cn } from '@/lib/utils/cn';

/**
 * Button — primary interactive primitive.
 *
 * Variants × sizes × states. The `loading` state shows an inline Spinner
 * and disables the button. Use semantic Tailwind token classes; never
 * hardcode colors. Shape responds to `data-display-style` via
 * `--radius-btn` (rectangles in default, pills in `soft`).
 *
 * @example
 * <Button variant="primary" size="md">Save</Button>
 * <Button variant="ghost" leftIcon={<Plus />} loading>Saving…</Button>
 */
const buttonVariants = cva(
  cn(
    // Base layout
    'inline-flex items-center justify-center gap-2',
    // Typography
    'font-sans text-sm font-medium leading-none',
    // Shape — semantic tokens that flip with display-style
    'rounded-(--radius-btn)',
    // Interaction
    'transition-[transform,background-color,border-color,color] duration-(--transition-duration)',
    'active:scale-(--active-scale)',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-50',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-(--el-accent) text-(--el-accent-text) hover:opacity-90',
        secondary:
          'bg-transparent text-(--el-text) border border-(--el-border-strong) hover:bg-(--el-surface)',
        ghost: 'bg-transparent text-(--el-text) hover:bg-(--el-surface)',
        danger: 'bg-(--el-danger) text-(--el-danger-text) hover:opacity-90',
      },
      size: {
        sm: 'h-(--height-btn-sm) px-3 text-xs',
        md: 'h-(--height-btn-md) px-(--spacing-btn-x)',
        lg: 'h-(--height-btn-lg) px-6 text-base',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows inline Spinner + disables interaction. */
  loading?: boolean;
  /** Icon rendered before the label. */
  leftIcon?: ReactNode;
  /** Icon rendered after the label. */
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, loading, leftIcon, rightIcon, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === 'lg' ? 'md' : 'sm'} aria-hidden />
      ) : leftIcon ? (
        <span aria-hidden className="inline-flex">
          {leftIcon}
        </span>
      ) : null}
      <span>{children}</span>
      {!loading && rightIcon ? (
        <span aria-hidden className="inline-flex">
          {rightIcon}
        </span>
      ) : null}
    </button>
  );
});
