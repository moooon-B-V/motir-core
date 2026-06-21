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
import { IssueAppliedFilterBar } from '../../items/_components/IssueAppliedFilterBar';
import { AdvancedFilterSummary } from '../../items/_components/AdvancedFilterSummary';

// The board's applied-filter SUMMARY row (Story 6.15 · Subtask 6.15.3), per
// design/boards/board-filter.mock.html panel 3: the SAME shipped /items
// `IssueAppliedFilterBar` (the saved-filter name chip + dirty state +
// Save/Save-as/Discard) prepended to the 6.1.3 condition-chip readout
// (AdvancedFilterSummary), mounted ABOVE the board columns. Re-pointed at the
// board via the injected board-scoped `buildHref` so Discard returns to the
// board (not /items). Renders nothing when no filter is applied (the bar's own
// guard), so an unfiltered board shows no summary row.
//
// `view`/`sort` are inert (the board has neither); with `buildHref` injected the
// bar never reaches its `buildIssueListHref` fallback. Passed as the canonical
// defaults to satisfy the shared prop contract.

export interface BoardAppliedFilterBarProps {
  selectedBoardId?: string;
  projectKey: string;
  viewer: Viewer;
  filter: IssueFilter;
  ast: FilterAst | null;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  referencedLabels: LabelDto[];
}

export function BoardAppliedFilterBar({
  selectedBoardId,
  projectKey,
  viewer,
  filter,
  ast,
  statuses,
  members,
  sprints,
  customFields,
  components,
  referencedLabels,
}: BoardAppliedFilterBarProps) {
  const buildHref = useCallback(
    (next: IssueFilter) => buildBoardFilterHref({ boardId: selectedBoardId, filter: next }),
    [selectedBoardId],
  );

  return (
    <IssueAppliedFilterBar
      projectKey={projectKey}
      viewer={viewer}
      view="tree"
      sort={DEFAULT_SORT}
      filter={filter}
      ast={ast}
      buildHref={buildHref}
    >
      {ast !== null ? (
        <AdvancedFilterSummary
          ast={ast}
          statuses={statuses}
          members={members}
          sprints={sprints}
          customFields={customFields}
          components={components}
          referencedLabels={referencedLabels}
        />
      ) : null}
    </IssueAppliedFilterBar>
  );
}
