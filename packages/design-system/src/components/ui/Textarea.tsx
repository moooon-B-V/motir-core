import {
  forwardRef,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type TextareaHTMLAttributes,
} from 'react';
import { FormField, describedById } from './FormField';
import { cn } from '../../utils/cn';

/**
 * Textarea — multi-line text field. Mirrors Input's props (label, error,
 * helperText) but no prefix/suffix slots (uncommon shape for textareas).
 *
 * **Auto-resize is OPT-IN.** Pass `rows` alone and the field is a fixed height,
 * exactly as it has always been. Pass `autoGrow` and `rows` becomes the MINIMUM:
 * the field grows with its content, line by line, up to `maxRows`, then stops
 * and scrolls inside itself. A chat composer passes `rows={1}`.
 *
 * @example
 * <Textarea label="Description" rows={4} helperText="Max 500 chars" />
 * <Textarea autoGrow rows={1} maxRows={8} aria-label="Message" />
 */
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
  /**
   * Grow with the content instead of standing at a fixed `rows`. Default
   * `false`, so every existing caller renders byte-for-byte as before.
   *
   * With it, `rows` is the MINIMUM height and the manual resize handle is
   * removed — a hand-dragged height is overwritten by the next keystroke's
   * measurement, so the two cannot both be offered.
   */
  autoGrow?: boolean;
  /**
   * The cap, in rows, for an `autoGrow` field. Omitted means no cap: the field
   * grows for as long as its content does. Meaningless without `autoGrow`.
   */
  maxRows?: number;
}

/**
 * Measure and clamp — in JS, deliberately, not on `field-sizing: content`
 * alone. That property has not shipped in every engine the product supports;
 * this path behaves the same everywhere and is testable in jsdom by stubbing
 * `scrollHeight`.
 *
 * The line height, padding and border are read from the COMPUTED style rather
 * than assumed, so the clamp stays exact under every palette, type scale and
 * density the design system's axes produce.
 */
function resize(el: HTMLTextAreaElement, rows: number, maxRows: number | undefined): void {
  const cs = getComputedStyle(el);
  // `normal` has no pixel value to clamp against; fall back to the font size's
  // usual ratio rather than guessing a constant.
  const parsedLineHeight = Number.parseFloat(cs.lineHeight);
  const lineHeight = Number.isFinite(parsedLineHeight)
    ? parsedLineHeight
    : Number.parseFloat(cs.fontSize) * 1.2;
  const padding = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
  // `box-sizing: border-box` is the design system's default, so the border is
  // inside the height we set and has to be added back to the content we measure.
  const border =
    cs.boxSizing === 'border-box'
      ? Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth)
      : 0;

  const min = rows * lineHeight + padding + border;
  const max = maxRows === undefined ? Infinity : maxRows * lineHeight + padding + border;

  // Reset first: `scrollHeight` reports the CURRENT box when the content fits,
  // so a field that has already grown would never shrink back.
  el.style.height = 'auto';
  const needed = el.scrollHeight + border;
  const next = Math.min(Math.max(needed, min), max);
  el.style.height = `${next}px`;
  // Below the cap there is nothing to scroll, and a scrollbar that appears for
  // one frame while growing is the tell that this is done wrong.
  el.style.overflowY = needed > max ? 'auto' : 'hidden';
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, helperText, id, className, disabled, rows = 3, autoGrow, maxRows, ...rest },
  ref,
) {
  const autoId = useId();
  const textareaId = id ?? autoId;
  const describedBy = describedById(textareaId, error, helperText);
  const hasError = Boolean(error);
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  // The caller's ref still has to reach the <textarea> — the planning composer
  // builds its key handling on it — so the two are merged rather than replaced.
  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  // LAYOUT effect, not a plain one: a field mounted with a pre-filled value must
  // paint at its final height, and an ordinary effect lets the browser paint one
  // line first — the flash a seeded composer would show on every open.
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el || !autoGrow) return;
    resize(el, rows, maxRows);
    // The height follows the VALUE whoever changes it — typing, a paste, a
    // controlled value set by the parent (a prefill, or a clear to '' after
    // send) — and `rest.value` is what re-runs this for the controlled case.
    // It also follows the WIDTH, because wrapping changes with width, which no
    // value change reports.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => resize(el, rows, maxRows));
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoGrow, rows, maxRows, rest.value, rest.defaultValue]);

  return (
    <FormField label={label} error={error} helperText={helperText} htmlFor={textareaId}>
      <textarea
        ref={setRefs}
        id={textareaId}
        rows={rows}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        className={cn(
          'w-full rounded-(--radius-input) border bg-(--el-page-bg)',
          autoGrow ? 'resize-none' : 'resize-y',
          'px-(--spacing-input-x) py-(--spacing-input-y)',
          'font-sans text-sm text-(--el-text) placeholder:text-(--el-text-muted)',
          'transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-(--focus-ring-color) focus:ring-offset-2 focus:ring-offset-background',
          hasError ? 'border-(--el-danger)' : 'border-(--el-border-strong)',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...rest}
        // AFTER the spread, deliberately: it must not be replaceable, because
        // the height is the primitive's own contract. A caller's own `onInput`
        // still runs — it is called through, not dropped.
        onInput={(event) => {
          if (autoGrow) resize(event.currentTarget, rows, maxRows);
          rest.onInput?.(event);
        }}
      />
    </FormField>
  );
});
