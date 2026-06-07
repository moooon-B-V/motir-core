'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

// Segmented — a single-select inline control: a row of mutually-exclusive
// buttons where the active option is raised (`aria-pressed`). The accessible,
// space-cheap alternative to a `<select>` when the option set is small and worth
// showing at a glance (the board group-by, Subtask 3.3.5; reusable beyond it).
//
// Built FROM the design system per `design/boards/swimlanes-wip.mock.html` (the
// `.seg` block): an `--el-surface` track with a 2px inset, each option a
// `--radius-control` button; the pressed option gets the `--el-page-bg` raised
// fill + `--shadow-subtle` and its leading glyph takes the `--el-accent` hue.
// Colour via `--el-*`, shape via element-semantic tokens (the colour + shape
// swap rules). A11y: a labelled `role="group"`; each option is a real `<button>`
// carrying `aria-pressed`, so it is keyboard-operable and announced as a toggle.

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Optional leading glyph (decorative — the label carries the accessible name). */
  icon?: ReactNode;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  disabled,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible group name (e.g. "Swimlane group by") — not rendered visually. */
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) p-0.5',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => {
              if (!active) onChange(opt.value);
            }}
            className={cn(
              'inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) text-[13px] font-medium transition-colors',
              'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              active
                ? 'bg-(--el-page-bg) text-(--el-text-strong) shadow-(--shadow-subtle) [&_.seg-ic]:text-(--el-accent)'
                : 'text-(--el-text-secondary) hover:text-(--el-text) [&_.seg-ic]:text-(--el-text-faint)',
            )}
          >
            {opt.icon ? (
              <span className="seg-ic inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {opt.icon}
              </span>
            ) : null}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
