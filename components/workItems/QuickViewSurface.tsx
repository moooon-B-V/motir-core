import type { ReactNode } from 'react';

// The READ-ONLY chrome of a quick-view peek — extracted from
// `IssueQuickViewPanel` so a PROPOSAL can be read with the same grammar a work
// item is (MOTIR-3084, per MOTIR-3082's design Part V §3).
//
// ── Why an extraction, and not a second mount ───────────────────────────────
// `IssueQuickViewPanel` is not a read-only presenter: it is a work-item EDITOR.
// It takes `QuickViewData` (id, identifier, labels, components, custom fields,
// members…) and wires editing hooks keyed by `workItemId`. A proposal has none
// of that — no id, no identifier, no labels — so mounting that panel for one
// would mean synthesising a fake work item and then suppressing every edit
// affordance it grew. That is the "second peek that drifts" failure wearing the
// shipped panel's clothes.
//
// So what both peeks share is the CHROME and the TYPOGRAPHY — the header rail,
// the two-column body, the section caption, the rail row — as composable pieces
// rather than one component with `head`/`main`/`rail` slots. That keeps each
// peek's own content where it already lives (no interior moved, no props
// drilled through a ReactNode) while giving the grammar ONE definition.
//
// Deliberately presentational: no fetching, no state, no domain types.

/** The peek's header rail: the row of affordances above the body. */
export function QuickViewHeader({ children }: { children: ReactNode }) {
  return (
    <header className="flex flex-none items-center gap-2.5 border-b border-(--el-border) py-3.5 pr-4 pl-5">
      {children}
    </header>
  );
}

/**
 * The two-column body. `railed` is false for a peek with no core-fields rail,
 * which collapses it to a single column rather than leaving an empty gutter.
 */
export function QuickViewBody({
  children,
  railed = true,
}: {
  children: ReactNode;
  railed?: boolean;
}) {
  return (
    <div
      className={`grid min-h-0 flex-1 grid-cols-1 ${
        railed ? 'md:grid-cols-[minmax(0,1fr)_300px]' : ''
      }`}
    >
      {children}
    </div>
  );
}

/** The scrollable main column — title, bodies, banners. */
export function QuickViewMain({ children }: { children: ReactNode }) {
  return <div className="min-w-0 overflow-y-auto px-7 pt-6 pb-7">{children}</div>;
}

/**
 * The core-fields rail beside the main column.
 *
 * `foot` is PINNED beneath the scroller rather than appended inside it
 * (MOTIR-4184, design Part XIV §3): proposal mode's count line is a statement
 * ABOUT the rows above it, and the rail overflows its track on an ordinary card
 * — measured 832px of content in 613 — so a line at the bottom of the scroll
 * space is a line most readers never reach. Without it the markup is exactly
 * what it always was: a bare `<dl>`, unchanged for the six committed hosts.
 */
export function QuickViewRail({ children, foot }: { children: ReactNode; foot?: ReactNode }) {
  const list = (
    <dl
      className={`flex min-w-0 flex-col gap-4 overflow-y-auto px-5 py-6 ${
        foot ? 'flex-1' : 'border-l border-(--el-border) bg-(--el-surface-soft)'
      }`}
    >
      {children}
    </dl>
  );
  if (!foot) return list;
  return (
    <div className="flex min-h-0 flex-col border-l border-(--el-border) bg-(--el-surface-soft)">
      {list}
      {foot}
    </div>
  );
}

/** A section caption in the main column (`DESCRIPTION`, `WHY THIS MATTERS`). */
export function QuickViewSectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`mt-6 mb-2 block text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase ${className ?? ''}`}
    >
      {children}
    </span>
  );
}

/** A rail field — uppercase caption over its value. */
export function QuickViewRailField({
  label,
  marker,
  children,
}: {
  label: string;
  /** The CHANGED chip, when a plan is moving this row (MOTIR-4184, Part XIV §3).
   *  Inside the `<dt>` so it is announced as part of the row's own term. */
  marker?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
        {label}
        {marker}
      </dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 text-sm text-(--el-text-secondary)">
        {children}
      </dd>
    </div>
  );
}
