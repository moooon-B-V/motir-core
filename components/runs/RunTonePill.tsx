import type { ReactNode } from 'react';
import type { RunTone } from '@/lib/runs/timeline';

// THE RUN AREA'S ONE TONE CHIP (MOTIR-3895), extracted from the two byte-identical
// copies that had grown in `items/[key]/_components/RunSection.tsx` (MOTIR-1796)
// and `runs/_components/RunsIndex.tsx` (MOTIR-3923).
//
// ⚠️ WHY IT IS A COMPONENT AND NOT A THIRD COPY. `lib/runs/timeline.ts` already
// owns the VOCABULARY — `DISPOSITION_TONE` and `RUN_STATUS_TONE` map both enums
// onto one `RunTone`, total over each, so nothing has to invent a tone. What it
// does not own is the RENDERING, and a surface that needs a chip has until now
// had to re-type the two class tables. Three copies of a ten-row table is how one
// of them quietly stops matching the design's tone table
// (`design/runs/design-notes.md` § THE TONE VOCABULARY), and a reader learns that
// the same word means two colours depending which page they are on.
//
// The tables are the design's, as tokens: the chip's FILL is a tint, its INK is
// always `--el-text-strong` on that tint (never a per-tone ink, which is how a
// contrast arm gets missed), and the DOT carries the hue. No Tier-0 `--color-*`,
// no invented hue, and no border-style signal.

/** The area's tone table (`design-notes.md` § THE TONE VOCABULARY) as tokens. */
const TONE_CLASS = {
  queued: 'bg-(--el-muted) text-(--el-text-strong)',
  running: 'bg-(--el-tint-sky) text-(--el-text-strong)',
  integrated: 'bg-(--el-tint-mint) text-(--el-text-strong)',
  implemented: 'bg-(--el-tint-mint) text-(--el-text-strong)',
  failed: 'bg-(--el-tint-rose) text-(--el-text-strong)',
  replanned: 'bg-(--el-tint-lavender) text-(--el-text-strong)',
  skipped: 'bg-(--el-muted) text-(--el-text-strong)',
  cancelled: 'bg-(--el-muted) text-(--el-text-strong)',
  timedout: 'bg-(--el-tint-peach) text-(--el-text-strong)',
  offline: 'bg-(--el-tint-peach) text-(--el-text-strong)',
} as const satisfies Record<RunTone, string>;

/** The DOT's hue. The chip's ink is always `--el-text-strong` on its tint. */
const DOT_CLASS = {
  queued: 'bg-(--el-status-todo)',
  running: 'bg-(--el-status-in-progress)',
  integrated: 'bg-(--el-status-done)',
  implemented: 'bg-(--el-status-done)',
  failed: 'bg-(--el-danger)',
  replanned: 'bg-(--el-status-planning)',
  skipped: 'bg-(--el-text-tertiary)',
  cancelled: 'bg-(--el-status-cancelled)',
  timedout: 'bg-(--el-warning)',
  offline: 'bg-(--el-text-tertiary)',
} as const satisfies Record<RunTone, string>;

export function RunTonePill({
  tone,
  children,
  compact = false,
}: {
  tone: RunTone;
  children: ReactNode;
  /** A smaller chip, for a canvas node where the pill sits inside a 190px box. */
  compact?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-(--radius-badge) font-sans font-medium ${
        compact
          ? 'gap-1 px-1.5 py-px text-[10px]'
          : 'gap-1.5 px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs'
      } ${TONE_CLASS[tone]}`}
    >
      <span
        className={`${compact ? 'size-[5px]' : 'size-[7px]'} rounded-full ${DOT_CLASS[tone]}`}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}
