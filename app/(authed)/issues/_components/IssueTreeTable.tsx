'use client';

import { useState } from 'react';
import { TreeTable, type TreeTableColumn, type TreeTableRow } from '@/components/ui/TreeTable';
import { ISSUE_COLUMNS } from './issueColumns';
import type { IssueRowData } from './issueRows';

// The /issues TREE table (Subtask 2.5.3) — the client wrapper that composes the
// generic TreeTable primitive (2.5.2) with the shared issue cells (issueColumns,
// 2.5.8) from design/work-items/tree.png: TITLE (type icon + identifier + title),
// PRIORITY, ASSIGNEE, REPORTER, DUE, EST., STATUS. The whole row links to the
// issue's detail page. Expand/collapse is client-held; the default expands the
// roots one level (matching the mockup), with no per-row persistence in v1.
// Inline status/assignee editing layers onto these cells in 2.5.5. The flat,
// sortable List view (IssueListTable, 2.5.8) reuses the SAME cells un-nested.

// Drop the List-only `sortColumn` (the Tree doesn't sort) and keep the
// TreeTable column shape — the cells are identical across views.
const COLUMNS: TreeTableColumn<IssueRowData>[] = ISSUE_COLUMNS.map(
  ({ key, header, width, align, cell }) => ({ key, header, width, align, cell }),
);

export interface IssueTreeTableProps {
  rows: TreeTableRow<IssueRowData>[];
}

export function IssueTreeTable({ rows }: IssueTreeTableProps) {
  // Default: expand the roots one level (their children show; deeper levels
  // stay collapsed), matching the mockup. Client-held, no persistence in v1.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.children && r.children.length > 0).map((r) => r.id)),
  );

  return (
    <TreeTable
      label="Issues"
      columns={COLUMNS}
      rows={rows}
      expandedIds={expandedIds}
      onExpandedChange={setExpandedIds}
      getRowHref={(r) => `/issues/${r.identifier}`}
      getRowLabel={(r) => `${r.identifier} ${r.title}`}
      getRowTestId={(r) => `issue-row-${r.identifier}`}
    />
  );
}
