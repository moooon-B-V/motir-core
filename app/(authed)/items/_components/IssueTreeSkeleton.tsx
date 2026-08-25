// The loading skeleton for the /items tables (Subtask 2.5.3; flat variant in
// 2.5.8), per design/work-items/tree.png panel 3 + list.mock.html panel 4: the
// same column header as the real table, then shimmer rows. Purely presentational
// + static, so it's the Suspense fallback while the Server Component streams.
// Mirrors the table container chrome (rounded, bordered, header tint) so there's
// no layout shift on settle.
//
// ⚠️ The grid template and the header labels are DERIVED from
// `buildIssueColumns` — the same registry both real tables build their
// `gridTemplateColumns` from — and are never restated here. They used to be two
// local constants kept in sync by a comment saying they were, and they were not:
// Type (116px), Points (80px) and Actions (76px) arrived between 2026-06-06 and
// 2026-06-19 and none of the three swept this file, so for eighty days the
// fallback laid out 272px less fixed track than the table it stands in for. The
// `1fr` Title column was lent all of it and took it back on settle — a visible
// horizontal jump on every load, sort, filter change and view switch, which is
// the exact defect the skeleton exists to prevent (bug MOTIR-3452, restoring
// MOTIR-1307). Derivation is the mechanism; the equality assertions in
// tests/components/issue-tree-skeleton-grid.test.tsx are what keep it one.
//
// `flat` (the List view) drops the per-row indent + the chevron slot — the one
// delta between the Tree skeleton and the List skeleton (the List is un-nested).
// It is a delta INSIDE the Title cell, not a track: both variants stand in for
// tables built from the same nine columns, so both emit the same grid.

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { ISSUE_TITLE_MIN_TRACK } from '@/lib/issues/issueListView';
import { buildIssueColumns, type IssueColumn } from './issueColumns';

const ROWS = [0, 1, 2, 3, 4, 5, 6, 7];
// Indent (px) per row — echoes the mockup's depth-varied shimmer.
const INDENT = [0, 22, 22, 44, 44, 66, 44, 22];

function Bar({ w }: { w: number }) {
  return (
    <span
      className="block h-3 rounded-(--radius-control) bg-(--el-muted)"
      style={{ width: w }}
      aria-hidden
    />
  );
}

/** An avatar dot + a name bar — the Assignee and Reporter cells' shape. */
function Person() {
  return (
    <span className="flex items-center gap-2">
      <span className="h-[22px] w-[22px] shrink-0 rounded-full bg-(--el-muted)" aria-hidden />
      <Bar w={64} />
    </span>
  );
}

/**
 * The shimmer standing in for one column's cell. Keyed off the registry's own
 * `key`, so the cells stay in the column ORDER the grid is built from; a column
 * this file has no drawn stand-in for falls through to a generic bar, which
 * keeps the cell count equal to the track count rather than leaving a hole in
 * the row. That default is the drift-tolerant arm — a tenth column renders
 * something sensible here while the equality test names it.
 */
function ShimmerCell({
  column,
  index,
  flat,
}: {
  column: IssueColumn;
  index: number;
  flat: boolean;
}): ReactNode {
  switch (column.key) {
    case 'title':
      // Flat List drops the indent + the chevron slot.
      return (
        <span className="flex items-center gap-2" style={{ paddingLeft: flat ? 0 : INDENT[index] }}>
          {flat ? null : (
            <span
              className="h-3.5 w-3.5 shrink-0 rounded-(--radius-control) bg-(--el-muted)"
              aria-hidden
            />
          )}
          <span
            className="h-4 w-4 shrink-0 rounded-(--radius-control) bg-(--el-muted)"
            aria-hidden
          />
          <Bar w={56} />
          <Bar w={140 + (index % 3) * 50} />
        </span>
      );
    case 'type':
      // The work-type chip (`rounded-(--radius-badge)`, like WorkItemTypeChip).
      return (
        <span className="block h-5 w-[72px] rounded-(--radius-badge) bg-(--el-muted)" aria-hidden />
      );
    case 'priority':
      return <span className="block h-5 w-16 rounded-full bg-(--el-muted)" aria-hidden />;
    case 'assignee':
    case 'reporter':
      return <Person />;
    case 'estimate':
      return (
        <span className="flex justify-end">
          <Bar w={36} />
        </span>
      );
    case 'points':
      // The right-aligned points badge (EstimateBadge / ParentRollupBadge).
      return (
        <span className="flex justify-end">
          <span className="block h-5 w-9 rounded-(--radius-badge) bg-(--el-muted)" aria-hidden />
        </span>
      );
    case 'status':
      return <span className="block h-5 w-20 rounded-full bg-(--el-muted)" aria-hidden />;
    case 'actions':
      // The trailing ⋯ actions trigger — one right-aligned icon button.
      return (
        <span className="flex justify-end">
          <span className="block h-5 w-5 rounded-(--radius-control) bg-(--el-muted)" aria-hidden />
        </span>
      );
    default:
      return (
        <span className={cn('flex', column.align === 'end' && 'justify-end')}>
          <Bar w={48} />
        </span>
      );
  }
}

export function IssueTreeSkeleton({ flat = false }: { flat?: boolean } = {}) {
  const t = useTranslations();
  const columns = buildIssueColumns(t);
  // Byte-for-byte the expression both IssueListTable and TreeTable build their
  // template from: the Title column flexes, floored at ISSUE_TITLE_MIN_TRACK so
  // it can't collapse into its neighbour under width pressure (bug MOTIR-1307);
  // every other column takes its registered fixed width.
  const gridTemplate = [
    `minmax(${ISSUE_TITLE_MIN_TRACK},1fr)`,
    ...columns.slice(1).map((c) => (c.width ? `${c.width}px` : 'max-content')),
  ].join(' ');

  return (
    <div
      className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
      aria-hidden
      data-testid="issue-tree-skeleton"
    >
      <div className="w-full animate-pulse text-sm">
        {/* Header — the registry's labels, in the registry's order. A column
        with no `sortColumn` (the trailing actions cell) has no visible caption
        in either real table, so it has none here either. */}
        <div
          className="grid items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) pr-7 pl-4"
          style={{ gridTemplateColumns: gridTemplate, height: 40 }}
        >
          {columns.map((col) => (
            <span
              key={col.key}
              className={cn(
                'min-w-0 truncate text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase',
                col.align === 'end' && 'text-right',
              )}
            >
              {col.sortColumn ? col.header : <span className="sr-only">{col.header}</span>}
            </span>
          ))}
        </div>

        {/* Shimmer rows — one cell per column, in the same order. */}
        {ROWS.map((i) => (
          <div
            key={i}
            className="grid items-center gap-x-4 border-b border-(--el-border) pr-7 pl-4 last:border-b-0"
            style={{ gridTemplateColumns: gridTemplate, height: 40 }}
          >
            {columns.map((col) => (
              <ShimmerCell key={col.key} column={col} index={i} flat={flat} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
