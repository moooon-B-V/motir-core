import { forwardRef, useId, type TextareaHTMLAttributes } from 'react';
import { FormField, describedById } from './FormField';
import { cn } from '@/lib/utils/cn';

/**
 * Textarea — multi-line text field. Mirrors Input's props (label, error,
 * helperText) but no prefix/suffix slots (uncommon shape for textareas).
 * Auto-resize is intentionally NOT supported in v1 — pass `rows` to size.
 *
 * @example
 * <Textarea label="Description" rows={4} helperText="Max 500 chars" />
 */
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, helperText, id, className, disabled, rows = 3, ...rest },
  ref,
) {
  const autoId = useId();
  const textareaId = id ?? autoId;
  const describedBy = describedById(textareaId, error, helperText);
  const hasError = Boolean(error);
  return (
    <FormField label={label} error={error} helperText={helperText} htmlFor={textareaId}>
      <textarea
        ref={ref}
        id={textareaId}
        rows={rows}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        className={cn(
          'w-full resize-y rounded-(--radius-input) border bg-background',
          'px-(--spacing-input-x) py-(--spacing-input-y)',
          'font-sans text-sm text-foreground placeholder:text-muted-foreground',
          'transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-(--focus-ring-color) focus:ring-offset-2 focus:ring-offset-background',
          hasError ? 'border-(--color-destructive)' : 'border-(--color-hairline-strong)',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...rest}
      />
    </FormField>
  );
});
