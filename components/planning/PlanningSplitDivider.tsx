'use client';

import { type KeyboardEvent, type PointerEvent } from 'react';

/**
 * The planning split's DIVIDER (MOTIR-6250), built to MOTIR-6249's approved
 * design result.
 *
 * ── WHY ITS OWN FILE AND NOT A DESIGN-SYSTEM PRIMITIVE ──────────────────────
 * MOTIR-6250 asks for the decision on the evidence, and the evidence is that
 * there is exactly ONE consumer: `PlanningResizableFrame`. A second consumer is
 * what earns a primitive, and the plan page is explicitly NOT one — both
 * MOTIR-6250 (*"Does NOT change: … the plan page's rail"*) and MOTIR-6236
 * (*"This host is NOT a split"*) say so. Promoting it to `packages/design-system`
 * today would publish a shape nothing else consumes and make its first real
 * second consumer a breaking change rather than a reuse.
 *
 * ── THE GEOMETRY IS THE DESIGN'S ────────────────────────────────────────────
 * 1px visible, an 11px hit area ABSOLUTELY POSITIONED over the seam so the grid
 * pays nothing for it and neither pane shifts by a pixel when it lights up, and
 * the growth is symmetric (±1px about the line's own centre) for the same reason.
 * Ink steps `--el-border` → `--el-border-strong` → `--el-accent` across rest →
 * hover → drag, over 120ms ease-out.
 *
 * ⚠️ THE RESTING 1px LINE IS THE RAIL'S OWN `border-l`, NOT THIS COMPONENT'S —
 * a deliberate deviation from the design's MECHANISM that preserves its RESULT.
 * The design says the divider "TAKES the rail's own `border-l`… remove that, or
 * the seam gets two edges". Removing it would be right if this frame were the
 * rail's only host, and it is not: `PlanChangeRail`'s
 * `border-l border-(--el-border)` also draws the seam for `GenerationFlow` and
 * `DiscoveryOnboarding`, which keep the FIXED frame and are outside this card's
 * scope. So the rail keeps its 1px edge as the resting line — the same 1px of
 * `--el-border` the design specifies — and this component paints only the 3px
 * hover / focus / drag states, which cover it exactly. One resting edge, no
 * double line, four other consumers untouched.
 */
export interface PlanningSplitDividerProps {
  /** The conversation pane's current width in CSS pixels — `aria-valuenow`. */
  widthPx: number;
  /** The conversation pane's bounds in CSS pixels. */
  min: number;
  max: number;
  /** Accessible name; the caller owns the copy so it can be translated. */
  label: string;
  /** True while a pointer drag is in flight — paints the `--el-accent` state. */
  dragging: boolean;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

export function PlanningSplitDivider({
  widthPx,
  min,
  max,
  label,
  dragging,
  onPointerDown,
  onKeyDown,
}: PlanningSplitDividerProps) {
  return (
    <div
      // `role="separator"` WITH `tabindex` is the focusable variant, and that is
      // what makes `aria-valuenow` meaningful: a non-focusable separator is
      // decorative and carries no value.
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuenow={Math.round(widthPx)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-label={label}
      data-testid="planning-split-divider"
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      // The 11px strip sits OVER the seam: `right` is the rail's own width pulled
      // back by half the strip, so the line at its centre lands exactly on the
      // boundary. `z-10` clears both panes' content; `touch-none` stops a touch
      // drag scrolling a pane instead of moving the divider. The focus ring is on
      // the STRIP, never the 1px line, which would be narrower than its own ring.
      className="group/divider absolute inset-y-0 z-10 w-[11px] cursor-col-resize touch-none select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-inset"
      style={{ right: 'calc(var(--rail-w) - 5px)' }}
    >
      <span
        aria-hidden
        data-testid="planning-split-divider-line"
        className={[
          'pointer-events-none absolute inset-y-0',
          'transition-[width,left,background-color] duration-[120ms] ease-out',
          // At rest the line is TRANSPARENT and 1px: the rail's own border is the
          // resting edge. Hover and keyboard focus both grow it to 3px about its
          // centre — `left` moves 5px → 4px as the width goes 1px → 3px.
          dragging
            ? 'left-1 w-[3px] bg-(--el-accent)'
            : [
                'left-[5px] w-px bg-transparent',
                'group-hover/divider:left-1 group-hover/divider:w-[3px] group-hover/divider:bg-(--el-border-strong)',
                'group-focus-visible/divider:left-1 group-focus-visible/divider:w-[3px] group-focus-visible/divider:bg-(--el-border-strong)',
              ].join(' '),
        ].join(' ')}
      />
    </div>
  );
}
