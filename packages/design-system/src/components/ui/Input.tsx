import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { FormField, describedById } from './FormField';
import { cn } from '../../utils/cn';

/**
 * Input — single-line text field with optional label, helper text, error
 * state, and addon slots (e.g. icons or labels).
 *
 * Note: `addonStart`/`addonEnd` are used instead of `prefix`/`suffix` because
 * `prefix` is a reserved HTML attribute on <input> (string-typed) and would
 * collide with our ReactNode prop.
 *
 * ── The non-editable states are COLOUR, never opacity (MOTIR-2495) ──────────
 * `disabled` used to render as `opacity-50` on the wrapper. Opacity composites
 * the whole SUBTREE against the page, so it halved the contrast of the value,
 * the placeholder and the affixes alike — and the affix is not the disabled
 * control, it is a `<span>` beside it, so 1.4.3's disabled exemption does not
 * reach it. axe measured it: the org-URL `motir.co/` prefix was already
 * `--el-text-secondary`, the darkest caption ink in the palette (6.80:1 on
 * white), and landed under 4.5 at 50%. Reaching for a darker ink cannot fix
 * that — opacity halves whatever it is given — so the fix belongs to the state,
 * not to the call site.
 *
 * Of the three directions the defect left open (token the state · exempt the
 * affix · make the field read-only), this component takes the FIRST, because it
 * is the only one that generalises: every disabled field with a prefix, suffix,
 * unit or currency symbol is the same defect, and expressing the state as
 * `--el-input-disabled-*` puts it back inside the token layer the colour rule
 * already governs — AA-checkable, palette-swappable, measurable by the same
 * scanner as any other pair. Exempting the affix would have hidden a real
 * measurement behind a rule exclusion.
 *
 * The THIRD direction is a separate, correct answer to a different question —
 * which control a value like an unchangeable org slug should be — so `readOnly`
 * gets its own treatment here rather than borrowing the disabled one: a
 * non-editable FILL, but full-strength ink and normal focusability, because a
 * value you are meant to read and copy has to be reachable from the keyboard.
 * A disabled input is not focusable at all.
 *
 * The disabled state stays distinguishable from the enabled one through THREE
 * cues, not one — a filled background, a softer edge, and a lighter (still AA)
 * ink. That redundancy is deliberate: a surface-material style repaints
 * `[data-surface='input']` with a rule that outranks a utility class, so the
 * fill alone cannot be relied on.
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
    readOnly,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy = describedById(inputId, error, helperText);
  const hasError = Boolean(error);
  // `disabled` wins when a call site sets both — it is the stronger claim (the
  // control is inert, not merely uneditable), and it is the one that removes
  // the field from the tab order.
  const state: 'disabled' | 'readonly' | 'editable' = disabled
    ? 'disabled'
    : readOnly
      ? 'readonly'
      : 'editable';
  // Every ink below is measured against the FILL on the same row (see the
  // doc comment and theme.css's --el-input-disabled-* block). The affix is the
  // one that made this a bug: it is `aria-hidden` decoration structurally, but
  // it renders TEXT, so axe measures it like any other caption.
  const affixInk =
    state === 'disabled'
      ? 'text-(--el-input-disabled-text)'
      : state === 'readonly'
        ? 'text-(--el-text-secondary)'
        : 'text-(--el-icon-field)';
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
        data-state={state === 'editable' ? undefined : state}
        className={cn(
          'flex h-(--height-input) w-full items-center gap-2 rounded-(--radius-input) border',
          'px-(--spacing-input-x)',
          'transition-colors',
          'focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:ring-offset-2 focus-within:ring-offset-background',
          state === 'disabled'
            ? 'bg-(--el-input-disabled-bg)'
            : state === 'readonly'
              ? 'bg-(--el-input-readonly-bg)'
              : 'bg-(--el-page-bg)',
          hasError
            ? 'border-(--el-danger)'
            : state === 'disabled'
              ? 'border-(--el-input-disabled-border)'
              : 'border-(--el-input-border)',
          state === 'disabled' && 'cursor-not-allowed',
        )}
      >
        {addonStart ? (
          <span aria-hidden className={cn('inline-flex', affixInk)}>
            {addonStart}
          </span>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          readOnly={readOnly}
          className={cn(
            'flex-1 bg-transparent font-sans text-sm outline-none',
            // The placeholder is a pseudo-element that IS text (MOTIR-2489), so
            // it takes the same per-state ink the value does. `--el-text-muted`
            // clears AA on the white page by 0.04 and fails on both non-editable
            // fills, so it cannot follow the value onto them.
            state === 'disabled'
              ? 'cursor-not-allowed text-(--el-input-disabled-text) placeholder:text-(--el-input-disabled-text)'
              : state === 'readonly'
                ? 'text-(--el-text) placeholder:text-(--el-text-secondary)'
                : 'text-(--el-text) placeholder:text-(--el-text-muted)',
            'disabled:cursor-not-allowed',
            className,
          )}
          {...rest}
        />
        {addonEnd ? (
          <span aria-hidden className={cn('inline-flex', affixInk)}>
            {addonEnd}
          </span>
        ) : null}
      </div>
    </FormField>
  );
});
