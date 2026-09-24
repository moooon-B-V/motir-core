'use client';

import type { ReactNode } from 'react';
import { cn } from '../../utils/cn';

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
  fill,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible group name (e.g. "Swimlane group by") — not rendered visually. */
  label: string;
  className?: string;
  disabled?: boolean;
  /**
   * FILL the container instead of sizing to the options (MOTIR-6200, for
   * MOTIR-6199): the track becomes `w-full` and the segments divide it evenly.
   *
   * WHY IT IS A VARIANT AND NOT THE DEFAULT. The track is `inline-flex` with no
   * wrap and no shrink, so its width is `max-content` — fine in a toolbar that
   * can grow, and unsurvivable in a FIXED rail. The Difficulty editor sits in an
   * 18rem item-page rail and a 300px quick-view rail, and when its scale gained a
   * fourth member the track overran both. Filling makes the width the
   * CONTAINER's, so it holds at any label set, at any `--spacing-control-x`
   * (10 / 12 / 14px across the shipped styles) and at a fifth member.
   *
   * Off by default: every other call site keeps byte-identical markup.
   */
  fill?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'items-center gap-0.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-tabnav-track) p-0.5',
        fill ? 'flex w-full' : 'inline-flex',
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
              'inline-flex h-(--height-control) items-center gap-1.5 rounded-[calc(var(--radius-btn)-2px)] text-[13px] font-medium transition-colors',
              // In FILL mode the segment's width comes from the track, so the
              // per-style control padding no longer sizes it — keeping it would
              // re-introduce the token dependency the variant exists to remove.
              fill ? 'min-w-0 flex-1 justify-center px-1' : 'px-(--spacing-control-x)',
              'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              active
                ? 'bg-(--el-page-bg) text-(--el-text-strong) shadow-(--shadow-subtle)'
                : 'text-(--el-text-secondary) hover:text-(--el-text)',
            )}
          >
            {/* The icon and the trailing count take their ink HERE rather than
                through the segment's `[&_.seg-*]:…` descendant variants
                (MOTIR-2475). Two things follow: the glyph says it is
                `aria-hidden`, so its faint ink is one of the token's legitimate
                jobs; and the trailing COUNT — text a reader reads — is no
                longer painted at 2.4:1 on an inactive segment. */}
            {opt.icon ? (
              <span
                aria-hidden
                className={cn(
                  'seg-ic inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center',
                  active ? 'text-(--el-tabnav-active)' : 'text-(--el-text-faint)',
                )}
              >
                {opt.icon}
              </span>
            ) : null}
            {/* FILL mode gives each segment a share of the track rather than its
                own content width, so a long label has to yield rather than push.
                Truncating needs an element to truncate, hence the span — added
                ONLY in fill mode, so every other call site's markup is
                unchanged. */}
            {fill ? <span className="truncate">{opt.label}</span> : opt.label}
            {opt.trailing != null ? (
              <span
                className={cn(
                  'seg-trail text-[11px] font-semibold tabular-nums',
                  active ? 'text-(--el-tabnav-active)' : 'text-(--el-text-secondary)',
                )}
              >
                {opt.trailing}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
