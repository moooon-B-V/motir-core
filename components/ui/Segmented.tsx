'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

// Segmented — a single-select inline control: a row of mutually-exclusive
// buttons where the active option is raised (`aria-pressed`). The accessible,
// space-cheap alternative to a `<select>` when the option set is small and worth
// showing at a glance (the board group-by, Subtask 3.3.5; reusable beyond it).
//
// Built FROM the design system per `design/boards/swimlanes-wip.mock.html` (the
// `.seg` block): an `--el-surface` track (`--radius-btn`) with a 2px inset, each
// option a `calc(--radius-btn - 2px)` button so it NESTS in the track at any style
// (a fixed `--radius-control` floats wrong when a style pills `--radius-btn`); the
// pressed option gets the `--el-page-bg` raised fill + `--shadow-subtle` and its
// leading glyph takes the `--el-accent` hue.
// Colour via `--el-*`, shape via element-semantic tokens (the colour + shape
// swap rules). A11y: a labelled `role="group"`; each option is a real `<button>`
// carrying `aria-pressed`, so it is keyboard-operable and announced as a toggle.

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Optional leading glyph (decorative — the label carries the accessible name). */
  icon?: ReactNode;
  /** Optional trailing content after the label (e.g. the notification drawer's
   * unread count on the Direct tab, Subtask 5.7.5). Decorative — faint when the
   * option is inactive, the `--el-accent` hue when active (mirrors the leading
   * glyph's active treatment). */
  trailing?: ReactNode;
  /** Disable just this option — a forward-compatible seam (e.g. the Activity
   * card's History filter, Story 5.5's slot) drawn present-but-inert. */
  disabled?: boolean;
  /** Tooltip for the option (e.g. why a seam option is disabled). */
  title?: string;
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
        'inline-flex items-center gap-0.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-tabnav-track) p-0.5',
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
            disabled={disabled || opt.disabled}
            title={opt.title}
            onClick={() => {
              if (!active) onChange(opt.value);
            }}
            className={cn(
              // The segment radius nests inside the track: the track is
              // `rounded-(--radius-btn)` with a 2px (`p-0.5`) inset, so a segment
              // fits the shell only at `--radius-btn - 2px`. Using a fixed
              // `--radius-control` breaks when a style makes `--radius-btn` a full
              // pill (soft-playful / retrofuturism: pill track, but a small-radius
              // chip floating inside it). Mirrors AppearancePickers' option radius.
              'inline-flex h-(--height-control) items-center gap-1.5 rounded-[calc(var(--radius-btn)-2px)] px-(--spacing-control-x) text-[13px] font-medium transition-colors',
              'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              active
                ? 'bg-(--el-page-bg) text-(--el-text-strong) shadow-(--shadow-subtle) [&_.seg-ic]:text-(--el-tabnav-active) [&_.seg-trail]:text-(--el-tabnav-active)'
                : 'text-(--el-text-secondary) hover:text-(--el-text) [&_.seg-ic]:text-(--el-text-faint) [&_.seg-trail]:text-(--el-text-faint)',
            )}
          >
            {opt.icon ? (
              <span className="seg-ic inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {opt.icon}
              </span>
            ) : null}
            {opt.label}
            {opt.trailing != null ? (
              <span className="seg-trail text-[11px] font-semibold tabular-nums">
                {opt.trailing}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
