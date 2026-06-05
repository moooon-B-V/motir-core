import type { IssueListView, IssueSort } from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { IssueFilterBar } from './IssueFilterBar';
import { IssueViewSwitcher } from './IssueViewSwitcher';
import { NewIssueButton } from './NewIssueButton';

// The /issues toolbar (Subtask 2.5.3; view switcher 2.5.8; filter bar 2.5.4),
// per design/work-items/tree.png + list.mock.html + filter.mock.html:
// [Filter] · [Tree ▾ / List ▾] · [+ New issue].
//
// - Filter is the URL-driven, multi-select filter bar (IssueFilterBar, 2.5.4) —
//   the disabled placeholder seam is now a working control.
// - The view-switcher (IssueViewSwitcher, 2.5.8) toggles the nested Tree view
//   and the flat sortable List view via `?view=`.
// - New issue reuses the shipped create-issue modal (2.3.3) via NewIssueButton.
//
// All three carry the active view + sort + filter so navigating one PRESERVES
// the others (every control routes through buildIssueListHref). Server Component
// — the interactive bits (filter bar, switcher) are the client children.

export interface IssueListToolbarProps {
  view: IssueListView;
  sort: IssueSort;
  filter: IssueFilter;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
}

export function IssueListToolbar({ view, sort, filter, statuses, members }: IssueListToolbarProps) {
  return (
    <div className="flex items-center gap-2">
      <IssueFilterBar
        filter={filter}
        statuses={statuses}
        members={members}
        view={view}
        sort={sort}
      />
      <IssueViewSwitcher view={view} sort={sort} filter={filter} />
      <NewIssueButton />
    </div>
  );
}
