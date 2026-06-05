import { SlidersHorizontal } from 'lucide-react';
import type { IssueListView, IssueSort } from '@/lib/issues/issueListView';
import { IssueViewSwitcher } from './IssueViewSwitcher';
import { NewIssueButton } from './NewIssueButton';

// The /issues toolbar (Subtask 2.5.3, view switcher wired in 2.5.8), per
// design/work-items/tree.png + list.mock.html: [Filter] · [Tree ▾ / List ▾] ·
// [+ New issue].
//
// - Filter is a DISABLED placeholder shell here — it's wired into the working,
//   URL-driven filter bar in 2.5.4. Rendered now so the toolbar matches the
//   mockup and the layout doesn't shift when 2.5.4 lands.
// - The view-switcher (IssueViewSwitcher, 2.5.8) is now FUNCTIONAL — it toggles
//   the nested Tree view and the flat sortable List view via `?view=`.
// - New issue reuses the shipped create-issue modal (2.3.3) via NewIssueButton.

export interface IssueListToolbarProps {
  view: IssueListView;
  sort: IssueSort;
}

export function IssueListToolbar({ view, sort }: IssueListToolbarProps) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled
        aria-disabled
        title="Filtering arrives in a later update"
        className="inline-flex h-(--height-control) cursor-not-allowed items-center gap-2 rounded-(--radius-btn) border border-(--el-border) px-3 font-sans text-sm text-(--el-text-muted) opacity-60"
      >
        <SlidersHorizontal className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
        Filter
      </button>
      <IssueViewSwitcher view={view} sort={sort} />
      <NewIssueButton />
    </div>
  );
}
