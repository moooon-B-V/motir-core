import { type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * Internal layout wrapper shared by Input and Textarea — handles the
 * label / control / helper-or-error stack pattern. Not exported from
 * the design system; consumers compose <Input> and <Textarea> directly.
 */
export interface FormFieldProps {
  /** Visible label rendered above the control. */
  label?: string;
  /** Error message — overrides helperText when present. Sets aria-invalid. */
  error?: string;
  /**
   * How the error message renders: the default `text` is the quiet danger
   * line; `box` is the rose-tint inline-error box (hue in the background,
   * strong text — finding #35), the 2.4.9 grammar inline editors use.
   */
  errorVariant?: 'text' | 'box';
  /** Helper text rendered below the control. */
  helperText?: string;
  /** id of the control element — used to associate label + describedby. */
  htmlFor: string;
  className?: string;
  children: ReactNode;
}

export function FormField({
  label,
  error,
  errorVariant = 'text',
  helperText,
  htmlFor,
  className,
  children,
}: FormFieldProps) {
  const describedById = error ? `${htmlFor}-error` : helperText ? `${htmlFor}-helper` : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <label htmlFor={htmlFor} className="font-sans text-sm font-medium text-(--el-text)">
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p
          id={describedById}
          role="alert"
          className={cn(
            'font-sans text-xs',
            errorVariant === 'box' &&
              'bg-(--el-danger-surface) text-(--el-danger-surface-text) rounded-(--radius-control) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y)',
          )}
          style={errorVariant === 'box' ? undefined : { color: 'var(--el-danger)' }}
        >
          {error}
        </p>
      ) : helperText ? (
        <p id={describedById} className="text-(--el-text-muted) font-sans text-xs">
          {helperText}
        </p>
      ) : null}
    </div>
  );
}

/** Returns the aria-describedby id that consumers should pass to the control. */
export function describedById(
  htmlFor: string,
  error: string | undefined,
  helperText: string | undefined,
): string | undefined {
  return error ? `${htmlFor}-error` : helperText ? `${htmlFor}-helper` : undefined;
}
