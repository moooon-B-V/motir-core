'use client';

import { useCallback } from 'react';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import type { FilterAst } from '@/lib/filters/ast';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { LabelDto } from '@/lib/dto/labels';
import type { Viewer } from '@/app/(authed)/filters/_components/savedFiltersClient';
import { buildBoardFilterHref } from '@/lib/boards/boardFilterHref';
import { IssueFilterBar } from '../../issues/_components/IssueFilterBar';
import { IssueAdvancedFilter } from '../../issues/_components/IssueAdvancedFilter';
import { SavedFilterDropdown } from '../../issues/_components/SavedFilterDropdown';
import { useBoardFilterUi } from './BoardFilterUiContext';

// The board toolbar's filter affordances (Story 6.15 · Subtask 6.15.3), per
// design/boards/board-filter.mock.html panels 0–2: the enabled `[Filter]` quick
// popover + `[Advanced]` builder + `[Saved]` picker, mounted on the BOARD
// toolbar beside the 3.3 group-by Segmented. These are the SAME shipped /issues
// components, verbatim — NO hand-rolled board-specific filter UI — re-pointed at
// the board via the injected `buildHref` (board-scoped URL: `?board=` preserved,
// the filter params appended, no view/sort/page) so the state is shareable,
// reload-safe, and per board. The reused `IssueFilterBar` already carries the
// 6.15.5 Work type facet, so the board exposes it automatically.
//
// `view`/`sort` are inert here (the board has neither): with `buildHref`
// injected, the components never reach their `buildIssueListHref` fallback that
// would consume them — they're passed as the canonical defaults purely to
// satisfy the shared prop contract.
//
// The quick `[Filter]` popover's open state is lifted to BoardFilterUiContext so
// the over-cap banner's "Refine filter" CTA (rendered inside BoardContainer) can
// open it; the `[Advanced]` + `[Saved]` popovers keep their own open state
// (AdvancedFilterProvider / the saved-filter session), exactly as on /issues.

export interface BoardFilterControlsProps {
  /** The selected board id (`?board=`) — preserved by every filter navigation
   * so the filter is per board and switching boards does not leak it. */
  selectedBoardId?: string;
  filter: IssueFilter;
  ast: FilterAst | null;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  referencedLabels: LabelDto[];
  projectKey: string;
  viewer: Viewer;
}

export function BoardFilterControls({
  selectedBoardId,
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
}: BoardFilterControlsProps) {
  const ui = useBoardFilterUi();
  const buildHref = useCallback(
    (next: IssueFilter) => buildBoardFilterHref({ boardId: selectedBoardId, filter: next }),
    [selectedBoardId],
  );

  return (
    <>
      <IssueFilterBar
        filter={filter}
        statuses={statuses}
        members={members}
        view="tree"
        sort={DEFAULT_SORT}
        ast={ast}
        buildHref={buildHref}
        open={ui?.filterOpen}
        onOpenChange={ui?.setFilterOpen}
      />
      <IssueAdvancedFilter
        filter={filter}
        ast={ast}
        view="tree"
        sort={DEFAULT_SORT}
        statuses={statuses}
        members={members}
        sprints={sprints}
        customFields={customFields}
        components={components}
        referencedLabels={referencedLabels}
        projectKey={projectKey}
        buildHref={buildHref}
      />
      <SavedFilterDropdown
        projectKey={projectKey}
        viewer={viewer}
        view="tree"
        sort={DEFAULT_SORT}
        filter={filter}
        ast={ast}
        buildHref={buildHref}
      />
    </>
  );
}
