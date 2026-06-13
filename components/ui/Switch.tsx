import { cn } from '@/lib/utils/cn';

/**
 * Switch — a sliding on/off toggle (`role="switch"`), keyboard-operable.
 *
 * The shared primitive the design system names (notifications preferences
 * matrix, automation rule enable, …). Colour flows through `--el-*`; the knob +
 * track are genuinely-circular (`rounded-full`), the shape-rule carve-out for a
 * pill control. Always pass an `aria-label` (or wire an external `<label>` via
 * `id`) so the toggle is screen-reader-legible — a bare switch announces no
 * purpose.
 *
 * @example
 * <Switch checked={on} onCheckedChange={setOn} aria-label="Email for Mentioned" />
 */
export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name — required unless an external `<label htmlFor=id>` exists. */
  'aria-label'?: string;
  id?: string;
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  className,
  'aria-label': ariaLabel,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        checked
          ? 'border-(--el-accent) bg-(--el-accent)'
          : 'border-(--el-border-strong) bg-(--el-muted)',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block size-3.5 rounded-full bg-(--el-surface) shadow-(--shadow-subtle) transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
