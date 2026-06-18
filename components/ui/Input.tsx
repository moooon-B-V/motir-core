import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { FormField, describedById } from './FormField';
import { cn } from '@/lib/utils/cn';

/**
 * Input — single-line text field with optional label, helper text, error
 * state, and addon slots (e.g. icons or labels).
 *
 * Note: `addonStart`/`addonEnd` are used instead of `prefix`/`suffix` because
 * `prefix` is a reserved HTML attribute on <input> (string-typed) and would
 * collide with our ReactNode prop.
 *
 * @example
 * <Input label="Email" type="email" helperText="We'll never share it" />
 * <Input label="Domain" addonStart={<Globe />} addonEnd=".motir.dev" />
 */
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label?: string;
  error?: string;
  /** Error presentation — `text` (default) or the rose-tint `box` (see FormField). */
  errorVariant?: 'text' | 'box';
  helperText?: string;
  /** Rendered inside the input box on the left. */
  addonStart?: ReactNode;
  /** Rendered inside the input box on the right. */
  addonEnd?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    error,
    errorVariant,
    helperText,
    addonStart,
    addonEnd,
    id,
    className,
    disabled,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy = describedById(inputId, error, helperText);
  const hasError = Boolean(error);
  return (
    <FormField
      label={label}
      error={error}
      errorVariant={errorVariant}
      helperText={helperText}
      htmlFor={inputId}
    >
      <div
        // `data-surface` lets a surface-material style (glassmorphism) give the
        // control a translucent fill — see globals.css's material layer.
        data-surface="input"
        className={cn(
          'flex h-(--height-input) w-full items-center gap-2 rounded-(--radius-input) border bg-(--el-page-bg)',
          'px-(--spacing-input-x)',
          'transition-colors',
          'focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:ring-offset-2 focus-within:ring-offset-background',
          hasError ? 'border-(--el-danger)' : 'border-(--el-border-strong)',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        {addonStart ? (
          <span aria-hidden className="text-(--el-text-muted) inline-flex">
            {addonStart}
          </span>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          className={cn(
            'flex-1 bg-transparent font-sans text-sm text-(--el-text) outline-none placeholder:text-(--el-text-muted)',
            'disabled:cursor-not-allowed',
            className,
          )}
          {...rest}
        />
        {addonEnd ? (
          <span aria-hidden className="text-(--el-text-muted) inline-flex">
            {addonEnd}
          </span>
        ) : null}
      </div>
    </FormField>
  );
});
