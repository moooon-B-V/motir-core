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
 * product had been living with — a bare browser tick box, unstyled, in exactly
 * one place — would have been the first surface in Motir that visibly is not
 * part of the design system.
 *
 * ⚠️ TWO STATES, NOT THREE (Yue, 2026-08-09). An earlier revision carried a
 * `provenance` discriminator so a permission that came WITH the author's chosen
 * base could render a grey fill, distinct from the accent fill of one they added
 * on top. That distinction died with the stored `based_on` column: the editor
 * still lets an author START FROM a built-in, but nothing records it, so on a
 * re-edit there is no base to have come from and the two fills could not be told
 * apart honestly. A permission is held or it is not — and the accessible name
 * says which, so the state never rests on colour alone.
 *
 * Controlled, like `Switch`. `disabled` renders a non-interactive box rather
 * than hiding the row — the story's server-refused, non-`enforced` keys must
 * stay legible (and disabled text is the one place `--el-text-faint` is
 * legitimate, since 1.4.3 exempts it).
 *
 * @example
 * <Checkbox checked={held} onChange={setHeld} label="Add comments" />
 */
export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /**
   * The control's own name — what it is a box FOR. Rendered as the accessible
   * name together with the held/not-held clause; pass `labelVisible` to draw it
   * beside the box as well.
   */
  label: string;
  disabled?: boolean;
  /** Render `label` as visible text beside the box, not only as the a11y name. */
  labelVisible?: boolean;
  id?: string;
  className?: string;
}

/** The state clause the accessible name carries — never a colour, always words. */
export function checkboxStateLabel(checked: boolean): string {
  return checked ? 'Held' : 'Not held';
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  labelVisible,
  id,
  className,
}: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-label={`${label}, ${checkboxStateLabel(checked)}`}
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
            ? 'border-(--el-accent) bg-(--el-accent) text-(--el-accent-text)'
            : 'border-(--el-border-strong) bg-transparent text-transparent',
        )}
      >
        {/* The tick. `currentColor` inherits the ink the fill above picked. */}
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
