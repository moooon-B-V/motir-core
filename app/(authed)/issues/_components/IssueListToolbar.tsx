'use client';

import { ChevronDown, ListTree, SlidersHorizontal } from 'lucide-react';
import { NewIssueButton } from './NewIssueButton';

// The /issues toolbar (Subtask 2.5.3), per design/work-items/tree.png:
// [Filter] · [Tree ▾] · [+ New issue].
//
// - Filter is a DISABLED placeholder shell here — it's wired into the working,
//   URL-driven filter bar in 2.5.4. Rendered now so the toolbar matches the
//   mockup and the layout doesn't shift when 2.5.4 lands.
// - The view-switcher shows "Tree" as the active/only v1 mode. A flat, sortable
//   "List" mode is the documented seam behind this control (Epic 6 saved views);
//   disabled here so the surface is forward-compatible without inventing the
//   unspecified List view (no complexity for nothing).
// - New issue reuses the shipped create-issue modal (2.3.3) via NewIssueButton.

function ToolbarButton({
  icon,
  label,
  trailing,
  disabledHint,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  disabledHint: string;
}) {
  return (
    <button
      type="button"
      disabled
      aria-disabled
      title={disabledHint}
      className="inline-flex h-9 cursor-not-allowed items-center gap-2 rounded-(--radius-sm) border border-(--el-border) px-3 font-sans text-sm text-(--el-text-muted) opacity-60"
    >
      <span className="text-(--el-text-muted)" aria-hidden>
        {icon}
      </span>
      {label}
      {trailing}
    </button>
  );
}

export function IssueListToolbar() {
  return (
    <div className="flex items-center gap-2">
      <ToolbarButton
        icon={<SlidersHorizontal className="h-4 w-4" />}
        label="Filter"
        disabledHint="Filtering arrives in a later update"
      />
      <ToolbarButton
        icon={<ListTree className="h-4 w-4" />}
        label="Tree"
        trailing={<ChevronDown className="h-3.5 w-3.5" aria-hidden />}
        disabledHint="Tree is the only view in this version"
      />
      <NewIssueButton />
    </div>
  );
}
