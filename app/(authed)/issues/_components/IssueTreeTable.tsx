'use client';

import { useState } from 'react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { TreeTable, type TreeTableColumn, type TreeTableRow } from '@/components/ui/TreeTable';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { IssueRowData } from './issueRows';

// The /issues list table (Subtask 2.5.3) — the client wrapper that composes the
// generic TreeTable primitive (2.5.2) with the issue-specific cells from
// design/work-items/tree.png: TITLE (type icon + identifier + title), ASSIGNEE
// (avatar + name / "Unassigned"), STATUS (Pill by lifecycle category). The whole
// row links to the issue's detail page. Expand/collapse is client-held; the
// default expands the roots one level (matching the mockup), with no per-row
// persistence in v1. Inline status/assignee editing layers onto these cells in
// 2.5.5 (it raises its controls above the row's stretched link).

// Lifecycle category → Pill status tone — the same mapping the detail page's
// ChildList uses (todo→planned, in_progress→in-progress, done→done). All AA-safe
// (finding #35); an unclassifiable status falls back to a neutral Pill.
const STATUS_TONE: Record<StatusCategoryDto, NonNullable<PillProps['status']>> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

/** Initial-letter avatar — mirrors the detail rail / ChildList avatar. */
function Avatar({ name }: { name: string }) {
  return (
    <span
      className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[10px] font-semibold text-(--el-text-inverted)"
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

const COLUMNS: TreeTableColumn<IssueRowData>[] = [
  {
    key: 'title',
    header: 'Title',
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-2">
        <IssueTypeIcon type={r.kind} className="h-4 w-4 shrink-0" />
        <span className="shrink-0 font-mono text-xs text-(--el-text-muted)">{r.identifier}</span>
        <span className="min-w-0 flex-1 truncate text-(--el-text) group-hover:underline">
          {r.title}
        </span>
      </span>
    ),
  },
  {
    key: 'assignee',
    header: 'Assignee',
    width: 160,
    cell: (r) =>
      r.assigneeName ? (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={r.assigneeName} />
          <span className="truncate text-(--el-text-secondary)">{r.assigneeName}</span>
        </span>
      ) : (
        <span className="text-(--el-text-muted)">Unassigned</span>
      ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 130,
    cell: (r) =>
      r.statusCategory ? (
        <Pill status={STATUS_TONE[r.statusCategory]}>{r.statusLabel}</Pill>
      ) : (
        <Pill tone="neutral">{r.statusLabel}</Pill>
      ),
  },
];

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
