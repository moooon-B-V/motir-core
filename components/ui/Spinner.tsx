import { forwardRef, type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

/**
 * Spinner — pure CSS rotation indicator.
 *
 * Three sizes; works standalone or inside a Button's loading state.
 *
 * @example
 * <Spinner size="md" />
 * <Spinner size="sm" aria-label="Loading" />
 */
const spinnerVariants = cva(
  'inline-block animate-spin rounded-full border-current border-t-transparent',
  {
    variants: {
      size: {
        sm: 'h-4 w-4 border-[1.5px]',
        md: 'h-5 w-5 border-2',
        lg: 'h-8 w-8 border-[3px]',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export interface SpinnerProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, 'role'>, VariantProps<typeof spinnerVariants> {}

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { className, size, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      role="status"
      aria-label={rest['aria-label'] ?? 'Loading'}
      className={cn(spinnerVariants({ size }), className)}
      {...rest}
    />
  );
});
