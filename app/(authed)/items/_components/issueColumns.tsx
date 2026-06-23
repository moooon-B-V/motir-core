import type { ReactNode } from 'react';
import type { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemTypeChip } from '@/components/issues/WorkItemTypeChip';
import { EstimateBadge } from '@/components/issues/EstimateBadge';
import { ParentRollupBadge } from '@/components/issues/ParentRollupBadge';
import type { IssueSortColumn } from '@/lib/issues/issueListView';
import { Avatar } from './issueCellPrimitives';
import {
  InlineStatusCell,
  InlineAssigneeCell,
  InlinePriorityCell,
  InlineEstimateCell,
} from './IssueInlineEdit';
import { WorkItemRowActions } from './WorkItemRowActions';
import type { IssueRowData } from './issueRows';

// A next-intl global translator (from `useTranslations()` with no namespace), so
// the column builder can reach both the `issues.columns.*` headers and the
// `labels.priority.*` enum labels with full-path keys.
type Translator = ReturnType<typeof useTranslations>;

// The single source of truth for the /items row cells + column metadata
// (Subtask 2.5.8). BOTH views compose these: the nested Tree table (2.5.3,
// `IssueTreeTable`) maps them onto the generic `TreeTable` primitive, and the
// flat sortable List table (`IssueListTable`) renders them un-nested with
// sortable headers — so a cell renders IDENTICALLY in either view
// (design/work-items/tree.png + list.mock.html). Extracted here so neither
// table re-declares the cells; the columns are Title · Type · Priority ·
// Assignee · Reporter · Est. · Points · Status (Due is intentionally not a
// list/tree column — see the note where it used to sit).

// The STATUS_TONE map, the row `Avatar`, and the status/assignee cell VALUE
// renderers now live in the leaf `issueCellPrimitives` module, so the inline-edit
// cells (IssueInlineEdit) can share them without an import cycle. The STATUS and
// ASSIGNEE columns below render those inline-edit cells (read-only outside an
// `IssueInlineEditProvider`, editable within one — Subtask 2.5.5).

/**
 * One issue-list column. `cell` renders the row body (shared by both views);
 * `width`/`align` shape the grid; `sortColumn` is the {@link IssueSortColumn}
 * the List header sorts by when clicked (the Tree ignores it). The flexible
 * Title column has no `width` (it takes the remaining space) and sorts by the
 * issue `key` — the mono identifier leading the cell, the canonical order. A
 * column with NO `sortColumn` is non-sortable (the trailing row-actions cell):
 * both tables render its header as a screen-reader-only label, not a sort button.
 */
export interface IssueColumn {
  key: string;
  header: string;
  width?: number;
  align?: 'start' | 'end';
  sortColumn?: IssueSortColumn;
  cell: (row: IssueRowData) => ReactNode;
}

// Built per-render with a translator (rather than a module-level const) so the
// headers + the inline priority/"Unassigned" labels resolve in the active
// locale. Both table views (IssueListTable, IssueTreeTable) call this once with
// `useTranslations()` and consume the result.
export function buildIssueColumns(t: Translator): IssueColumn[] {
  return [
    {
      key: 'title',
      header: t('issues.columns.title'),
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
      // The work-TYPE chip (Story 2.7 type · Subtask 8.8.9) — surfaces each
      // leaf's `type` (code/design/…) via the shipped WorkItemTypeChip, in a
      // dedicated column right after Title so it stays vertically aligned across
      // the tree's per-depth indent (an inline chip would drift with the indent).
      // `null` on containers (epic/story) → the muted em-dash empty-cell
      // convention (no chip). Sortable like Jira's navigator Type column, which
      // also makes the header visible (a non-sortable header renders sr-only).
      // design/work-items/work-type-indicator.mock.html.
      key: 'type',
      header: t('issues.columns.type'),
      width: 116,
      sortColumn: 'type',
      cell: (r) =>
        r.type ? (
          <WorkItemTypeChip type={r.type} />
        ) : (
          <span className="text-(--el-text-faint)">—</span>
        ),
    },
    {
      key: 'priority',
      header: t('issues.columns.priority'),
      width: 120,
      sortColumn: 'priority',
      // Inline-editable inside an IssueInlineEditProvider (2.5.5); read-only chip
      // otherwise. The cell owns its own PRIORITY_META chip rendering.
      cell: (r) => <InlinePriorityCell row={r} />,
    },
    {
      key: 'assignee',
      header: t('issues.columns.assignee'),
      width: 150,
      sortColumn: 'assignee',
      // Inline-editable inside an IssueInlineEditProvider (2.5.5); read-only value
      // otherwise. The cell owns its own avatar/name vs. "Unassigned" rendering.
      cell: (r) => <InlineAssigneeCell row={r} />,
    },
    {
      key: 'reporter',
      header: t('issues.columns.reporter'),
      width: 150,
      sortColumn: 'reporter',
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={r.reporterName} />
          <span className="truncate text-(--el-text-secondary)">{r.reporterName}</span>
        </span>
      ),
    },
    // No Due column — due dates aren't a meaningful list/tree axis for Motir's
    // work (Yue): the column is removed from all three views (List · lazy Tree ·
    // static Tree). Due is still editable on the detail page's core-fields rail
    // and remains a filter field + the `due` sort axis in the contract — only the
    // table column is dropped. Removing it also frees ~136px, helping narrow
    // viewports (bug MOTIR-1307).
    {
      key: 'estimate',
      header: t('issues.columns.estimate'),
      // 72px (was 90) — the right-aligned mono duration ("10h 30m" ≈ 69px) fits,
      // and the tighter footprint pushes back the width at which the row starts
      // to clip (bug MOTIR-1307).
      width: 72,
      align: 'end',
      sortColumn: 'estimate',
      // Inline-editable inside an IssueInlineEditProvider (2.5.5); read-only value
      // otherwise.
      cell: (r) => <InlineEstimateCell row={r} />,
    },
    {
      // Story points (Subtask 4.3.4) — the agile estimate, a SEPARATE column
      // from the TIME Est. (both coexist, like the detail rail). A LEAF row
      // shows its own inline `EstimateBadge` (own picker + write;
      // `forceStoryPoints` keeps it a points column regardless of the project's
      // display statistic). A PARENT row (4.3.5) shows the rolled-up SUBTREE
      // total instead — the labelled `ParentRollupBadge`, lazily fetched per
      // parent (a roll-up of descendants, distinct from the parent's own
      // estimate, the way Jira rolls child points into an epic).
      key: 'points',
      header: t('issues.columns.points'),
      width: 80,
      align: 'end',
      sortColumn: 'points',
      cell: (r) =>
        r.hasChildren ? (
          <ParentRollupBadge itemId={r.id} variant="compact" className="w-full justify-end" />
        ) : (
          <EstimateBadge
            itemId={r.id}
            storyPoints={r.storyPoints}
            estimateMinutes={r.estimateMinutes}
            forceStoryPoints
            className="w-full justify-end"
          />
        ),
    },
    {
      key: 'status',
      header: t('issues.columns.status'),
      // 108px (was 130) — the widest status Pill ("In Progress" ≈ 88px) fits
      // with room to spare, and the tighter footprint pushes back the width at
      // which the row starts to clip (bug MOTIR-1307).
      width: 108,
      sortColumn: 'status',
      // Inline-editable inside an IssueInlineEditProvider (2.5.5); read-only Pill
      // otherwise. The cell owns its own category→tone rendering.
      cell: (r) => <InlineStatusCell row={r} />,
    },
    {
      // The trailing row-actions cell (Subtask 2.5.19 + 2.8.4) — shared by Tree +
      // List: the quick-view eye PLUS the ⋯ actions menu (Edit/Copy/Archive/
      // Delete). Non-sortable (no sortColumn); its header is a screen-reader-only
      // "Actions" label. Both controls are SIBLINGS of the row's stretched link,
      // raised above it so they never nest inside the link.
      key: 'actions',
      header: t('issues.columns.actions'),
      width: 76,
      align: 'end',
      cell: (r) => <WorkItemRowActions row={r} />,
    },
  ];
}
