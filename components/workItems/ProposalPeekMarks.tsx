import type { ReactNode } from 'react';

// The marks PROPOSAL MODE adds to the shipped peek (MOTIR-4184, design
// `design/ai-planning/design-notes.md` Part XIV §3 §4).
//
// Presentational and domain-free on purpose: the panel decides WHICH rows are
// marked and WHAT the count says; these render it. Keeping them here rather than
// inside `IssueQuickViewPanel` is what lets the panel's proposal arm stay a few
// conditionals instead of a second component — the whole point of the story.

/**
 * The CHANGED chip beside a rail row's label.
 *
 * ⚠️ THE TOKEN IS `--el-diff-moved`, and it is chosen by SEMANTIC rather than by
 * resemblance: it is the shipped diff family's own "changed" slot
 * (`theme.css`), already consumed by `RevisionDiff.tsx` for a chip whose word is
 * literally `changed`. Nothing is invented, and no second vocabulary for *this
 * moved* enters the product. It also resolves through `--color-tint-sky`, the
 * same Tier-0 source as the `change` op chip — so the rail speaks the header's
 * colour by construction rather than by copying a value, and a palette that
 * re-skins that source moves both.
 *
 * ⚠️ COLOUR IS NEVER THE ONLY CARRIER. The chip contains the WORD, so a reader
 * who cannot see the tint reads it, and it sits inside the row's `<dt>` so it is
 * announced as part of the term.
 */
export function ChangedMark({ label }: { label: string }) {
  return (
    <span
      data-testid="quick-view-changed-mark"
      className="ml-1.5 inline-flex items-center rounded-(--radius-badge) bg-(--el-diff-moved) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[10px] font-semibold text-(--el-text-strong) normal-case"
    >
      {label}
    </span>
  );
}

/**
 * The PINNED line at the foot of the rail column — what the silence means.
 *
 * ⚠️ IT SITS OUTSIDE THE RAIL'S SCROLLER, and that is a MEASUREMENT rather than
 * a preference (Part XIV §3). With the line inside, the rail holds 799px of
 * content in a 613px track — the shipped peek's own condition — so 186px sit
 * below the fold, the line among them, and so does a marked row. A line whose
 * whole job is to be read as a statement ABOUT the rows above it cannot live at
 * the bottom of their scroller: a reader would read twelve rows and never reach
 * it, which is exactly the ambiguity it exists to remove.
 *
 * It REPLACES the `Created / Updated` audit line rather than joining it. Those
 * are instants of the PLAN ROW, not of the work item, and the plan's own
 * timeline carries them better.
 */
export function ProposalRailFoot({ children }: { children: ReactNode }) {
  return (
    <p
      data-testid="quick-view-proposal-foot"
      className="m-0 flex-none border-t border-(--el-border-soft) px-5 py-3 font-sans text-xs text-(--el-text-secondary)"
    >
      {children}
    </p>
  );
}
