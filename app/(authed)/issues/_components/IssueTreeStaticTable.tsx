'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { TreeTable, type TreeTableColumn, type TreeTableRow } from '@/components/ui/TreeTable';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { buildIssueColumns } from './issueColumns';
import { IssueInlineEditProvider } from './IssueInlineEdit';
import type { IssueRowData } from './issueRows';

// The STATIC (non-lazy) /issues tree — used ONLY for the FILTERED view, where
// the read is the context-preserving `getProjectTree` (already bounded by the
// filter, so the whole matched forest is in hand and loading it is fine). The
// UNfiltered tree uses the lazy + sortable `IssueTreeTable` (2.5.14); a filtered
// result is narrowed, so it keeps the simpler whole-forest render with the
// matched nodes' ancestors retained. Headers are plain here (the filtered forest
// comes back key-asc — sorting a context-preserving tree is out of v1 scope).

export interface IssueTreeStaticTableProps {
  rows: TreeTableRow<IssueRowData>[];
  /** The project workflow + workspace members enable inline status/assignee edits
   *  (Subtask 2.5.5); omit them to render read-only cells. */
  workflow?: WorkflowDto;
  members?: WorkspaceMemberDTO[];
}

export function IssueTreeStaticTable({ rows, workflow, members }: IssueTreeStaticTableProps) {
  const t = useTranslations();
  const columns: TreeTableColumn<IssueRowData>[] = buildIssueColumns(t).map(
    ({ key, header, width, align, cell, sortColumn }) => ({
      key,
      // The filtered tree's headers are plain (no sorting here), but the
      // non-sortable trailing actions column (2.5.19) still needs its label
      // hidden — a screen-reader-only "Actions" rather than a visible caption.
      header: sortColumn ? header : <span className="sr-only">{header}</span>,
      headerLabel: header,
      width,
      align,
      cell,
    }),
  );

  // Expand the roots one level so matched descendants are visible under their
  // retained ancestors (the context-preserving filter's whole point).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.children && r.children.length > 0).map((r) => r.id)),
  );

  const table = (
    <TreeTable
      label={t('issues.list.tableLabel')}
      columns={columns}
      rows={rows}
      expandedIds={expandedIds}
      onExpandedChange={setExpandedIds}
      getRowHref={(r) => `/issues/${r.identifier}`}
      getRowLabel={(r) => `${r.identifier} ${r.title}`}
      getRowTestId={(r) => `issue-row-${r.identifier}`}
    />
  );

  return workflow && members ? (
    <IssueInlineEditProvider workflow={workflow} members={members}>
      {table}
    </IssueInlineEditProvider>
  ) : (
    table
  );
}
