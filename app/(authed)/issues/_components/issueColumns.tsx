import type { ReactNode } from 'react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill, type PillProps } from '@/components/ui/Pill';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { PRIORITY_LABELS } from '@/lib/issues/priority';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import type { IssueSortColumn } from '@/lib/issues/issueListView';
import type { IssueRowData } from './issueRows';

// The single source of truth for the /issues row cells + column metadata
// (Subtask 2.5.8). BOTH views compose these: the nested Tree table (2.5.3,
// `IssueTreeTable`) maps them onto the generic `TreeTable` primitive, and the
// flat sortable List table (`IssueListTable`) renders them un-nested with
// sortable headers — so a cell renders IDENTICALLY in either view
// (design/work-items/tree.png + list.mock.html). Extracted here so neither
// table re-declares the cells; the columns are Title · Priority · Assignee ·
// Reporter · Due · Est. · Status, the set the detail page's core-fields surface.

// Lifecycle category → Pill status tone — the same mapping the detail page's
// ChildList uses (todo→planned, in_progress→in-progress, done→done). All AA-safe
// (finding #35); an unclassifiable status falls back to a neutral Pill.
export const STATUS_TONE: Record<StatusCategoryDto, NonNullable<PillProps['status']>> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

/** Initial-letter avatar — mirrors the detail rail / ChildList avatar. */
export function Avatar({ name }: { name: string }) {
  return (
    <span
      className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[10px] font-semibold text-(--el-text-inverted)"
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * One issue-list column. `cell` renders the row body (shared by both views);
 * `width`/`align` shape the grid; `sortColumn` is the {@link IssueSortColumn}
 * the List header sorts by when clicked (the Tree ignores it). The flexible
 * Title column has no `width` (it takes the remaining space) and sorts by the
 * issue `key` — the mono identifier leading the cell, the canonical order.
 */
export interface IssueColumn {
  key: string;
  header: string;
  width?: number;
  align?: 'start' | 'end';
  sortColumn: IssueSortColumn;
  cell: (row: IssueRowData) => ReactNode;
}

export const ISSUE_COLUMNS: IssueColumn[] = [
  {
    key: 'title',
    header: 'Title',
    sortColumn: 'key',
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
    key: 'priority',
    header: 'Priority',
    width: 120,
    sortColumn: 'priority',
    cell: (r) => {
      const meta = PRIORITY_META[r.priority];
      return (
        <Pill {...meta.pill}>
          <meta.icon className="h-3 w-3" aria-hidden />
          {PRIORITY_LABELS[r.priority]}
        </Pill>
      );
    },
  },
  {
    key: 'assignee',
    header: 'Assignee',
    width: 150,
    sortColumn: 'assignee',
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
    key: 'reporter',
    header: 'Reporter',
    width: 150,
    sortColumn: 'reporter',
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-2">
        <Avatar name={r.reporterName} />
        <span className="truncate text-(--el-text-secondary)">{r.reporterName}</span>
      </span>
    ),
  },
  {
    key: 'due',
    header: 'Due',
    width: 120,
    sortColumn: 'due',
    cell: (r) =>
      r.dueLabel ? (
        <span className="truncate text-(--el-text-secondary)">{r.dueLabel}</span>
      ) : (
        <span className="text-(--el-text-muted)">—</span>
      ),
  },
  {
    key: 'estimate',
    header: 'Est.',
    width: 90,
    align: 'end',
    sortColumn: 'estimate',
    cell: (r) =>
      r.estimateLabel ? (
        <span className="truncate text-(--el-text-secondary)">{r.estimateLabel}</span>
      ) : (
        <span className="text-(--el-text-muted)">—</span>
      ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 130,
    sortColumn: 'status',
    cell: (r) =>
      r.statusCategory ? (
        <Pill status={STATUS_TONE[r.statusCategory]}>{r.statusLabel}</Pill>
      ) : (
        <Pill tone="neutral">{r.statusLabel}</Pill>
      ),
  },
];
