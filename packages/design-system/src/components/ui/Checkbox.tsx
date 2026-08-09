import { cn } from '../../utils/cn';

/**
 * Checkbox — a tick box for composing a SET (`role="checkbox"`).
 *
 * The design system's one new primitive for Story MOTIR-2257 (subtask
 * MOTIR-2465), named by `design/projects/design-notes.md` § *Primitives
 * composed* — the row **`Permission checkbox` — NEW**.
 *
 * ⚠️ NOT A `Switch`, AND THE DISTINCTION IS THE REASON THIS EXISTS. A switch
 * says *this setting is on now*; a checkbox says *this is part of the set I am
 * composing*. Twenty-eight switches on the role editor would read as
 * twenty-eight independent settings rather than one role being composed, which
 * is precisely the wrong mental model for the feature. The alternative the
 * product had been living with — a bare browser `<input type="checkbox">`,
 * unstyled, in exactly one place — would have been the first surface in Motir
 * that visibly is not part of the design system.
 *
 * ⚠️ THREE VISUAL STATES, TWO FILLS OVER ONE CONTROL. A permission in the role
 * editor can be ticked for two different reasons, and which one matters:
 *
 *   * `provenance: 'none'`     — not held: an empty box;
 *   * `provenance: 'base'`     — held, and it came WITH the chosen base: a grey
 *                                fill;
 *   * `provenance: 'added'`    — held, and the author added it on top: an accent
 *                                fill.
 *
 * ⚠️ "WHO GRANTED THIS" IS NEVER CARRIED BY FILL COLOUR ALONE. The design is
 * explicit about it, so the accessible name STATES the provenance in words —
 * *Held — from Viewer* / *Held — added* / *Not held* — and the distinction
 * survives with colour off, in a screen reader, and in a monochrome print. That
 * is why `baseLabel` exists: the base's display name is needed to say the
 * sentence, and a component cannot invent it.
 *
 * Controlled, like `Switch`. `disabled` renders a non-interactive box rather
 * than hiding the row — the story's server-refused, non-`enforced` keys must
 * stay legible (and disabled text is the one place `--el-text-faint` is
 * legitimate, since 1.4.3 exempts it).
 *
 * @example
 * <Checkbox
 *   checked={held}
 *   provenance={fromBase ? 'base' : 'added'}
 *   onChange={setHeld}
 *   label="Add comments"
 *   baseLabel="Viewer"
 * />
 */

/** Why a checked box is checked — see the class comment. */
export type CheckboxProvenance = 'none' | 'base' | 'added';

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /**
   * The control's own name — what it is a box FOR. Rendered as the accessible
   * name together with the provenance clause; pass `labelVisible` to draw it
   * beside the box as well.
   */
  label: string;
  /**
   * Which of the three states this box is in. Defaults to `added` when checked
   * and `none` when not, so a plain two-state checkbox needs no extra prop.
   */
  provenance?: CheckboxProvenance;
  /**
   * The BASE's display name, for the *Held — from Viewer* sentence. Required in
   * practice whenever `provenance` is `base`; without it the name falls back to
   * the base-less *Held — from the base*, which is still true and still not a
   * colour.
   */
  baseLabel?: string;
  disabled?: boolean;
  /** Render `label` as visible text beside the box, not only as the a11y name. */
  labelVisible?: boolean;
  id?: string;
  className?: string;
}

/** The state clause the accessible name carries — never a colour, always words. */
export function checkboxStateLabel(
  checked: boolean,
  provenance: CheckboxProvenance,
  baseLabel?: string,
): string {
  if (!checked) return 'Not held';
  if (provenance === 'base') return baseLabel ? `Held — from ${baseLabel}` : 'Held — from the base';
  return 'Held — added';
}

export function Checkbox({
  checked,
  onChange,
  label,
  provenance,
  baseLabel,
  disabled,
  labelVisible,
  id,
  className,
}: CheckboxProps) {
  const state: CheckboxProvenance = provenance ?? (checked ? 'added' : 'none');
  const accessibleName = `${label}, ${checkboxStateLabel(checked, state, baseLabel)}`;

  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-label={accessibleName}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'inline-flex items-center gap-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center rounded-(--radius-control) border transition-colors',
          checked
            ? state === 'base'
              ? // From the base: a QUIET fill. It is held, but the author did not
                // choose it — so it must read as inherited rather than as an act.
                'border-(--el-border-strong) bg-(--el-muted) text-(--el-text-secondary)'
              : 'border-(--el-accent) bg-(--el-accent) text-(--el-accent-text)'
            : 'border-(--el-border-strong) bg-transparent text-transparent',
        )}
      >
        {/* The tick. `stroke-current` inherits the ink the fill above picked, so
            the glyph is legible on both the grey and the accent box. */}
        <svg
          viewBox="0 0 24 24"
          className="size-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      {labelVisible ? <span className="font-sans text-sm text-(--el-text)">{label}</span> : null}
    </button>
  );
}
