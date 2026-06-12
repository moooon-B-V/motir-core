import type { IssueListView, IssueSort } from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import type { FilterAst } from '@/lib/filters/ast';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { LabelDto } from '@/lib/dto/labels';
import type { Viewer } from '@/app/(authed)/filters/_components/savedFiltersClient';
import { IssueFilterBar } from './IssueFilterBar';
import { IssueAdvancedFilter } from './IssueAdvancedFilter';
import { SavedFilterDropdown } from './SavedFilterDropdown';
import { IssueViewSwitcher } from './IssueViewSwitcher';
import { NewIssueButton } from './NewIssueButton';

// The /issues toolbar (Subtask 2.5.3; view switcher 2.5.8; filter bar 2.5.4;
// advanced builder 6.1.4), per design/work-items/tree.png + list.mock.html +
// filter.mock.html + filter-builder.mock.html:
// [Filter] · [Advanced] · [Tree ▾ / List ▾] · [+ New issue].
//
// - Filter is the URL-driven, multi-select facet bar (IssueFilterBar, 2.5.4) —
//   the quick path. With an active advanced AST beyond facet expressiveness it
//   renders SUPERSEDED (muted + badge + read-only popover).
// - Advanced is the filter BUILDER (IssueAdvancedFilter, 6.1.4) — registry-
//   driven condition rows writing the versioned `?filter=v1:` param.
// - Saved is the saved-filter dropdown (SavedFilterDropdown, 6.2.3) — apply /
//   star / search the project's saved filters + the built-in defaults.
// - The view-switcher (IssueViewSwitcher, 2.5.8) toggles the nested Tree view
//   and the flat sortable List view via `?view=`.
// - New issue reuses the shipped create-issue modal (2.3.3) via NewIssueButton.
//
// All controls carry the active view + sort + filter (the advanced param rides
// INSIDE `filter.advanced`) so navigating one PRESERVES the others (every
// control routes through buildIssueListHref). Server Component — the
// interactive bits are the client children.

export interface IssueListToolbarProps {
  view: IssueListView;
  sort: IssueSort;
  filter: IssueFilter;
  /** The decoded advanced AST (null when none/invalid — the page decodes). */
  ast: FilterAst | null;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  /** Epic-5 builder data (Subtask 6.1.5): the project's custom-field
   * definitions, its components, and the active AST's referenced labels. */
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  referencedLabels: LabelDto[];
  /** Project identifier — the Label editor's autocomplete read (6.1.5) AND
   * the [Saved] dropdown's reads (6.2.3). */
  projectKey: string;
  /** The actor's saved-filter tier (Subtask 6.2.3) — powers the [Saved]
   * dropdown's reads and per-row gating. */
  viewer: Viewer;
}

export function IssueListToolbar({
  view,
  sort,
  filter,
  ast,
  statuses,
  members,
  sprints,
  customFields,
  components,
  referencedLabels,
  projectKey,
  viewer,
}: IssueListToolbarProps) {
  return (
    <div className="flex items-center gap-2">
      <IssueFilterBar
        filter={filter}
        statuses={statuses}
        members={members}
        view={view}
        sort={sort}
        ast={ast}
      />
      <IssueAdvancedFilter
        filter={filter}
        ast={ast}
        view={view}
        sort={sort}
        statuses={statuses}
        members={members}
        sprints={sprints}
        customFields={customFields}
        components={components}
        referencedLabels={referencedLabels}
        projectKey={projectKey}
      />
      <SavedFilterDropdown
        projectKey={projectKey}
        viewer={viewer}
        view={view}
        sort={sort}
        filter={filter}
        ast={ast}
      />
      <IssueViewSwitcher view={view} sort={sort} filter={filter} />
      <NewIssueButton />
    </div>
  );
}
