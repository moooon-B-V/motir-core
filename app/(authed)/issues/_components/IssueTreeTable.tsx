'use client';

import { useCallback, useMemo, useState, useTransition, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { TreeTable, type TreeTableColumn, type TreeTableRow } from '@/components/ui/TreeTable';
import { cn } from '@/lib/utils/cn';
import {
  buildIssueListHref,
  nextSort,
  serializeSort,
  type IssueSort,
  type IssueSortColumn,
} from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import type { TreeLevelDto, WorkItemTreeRowDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { buildIssueColumns } from './issueColumns';
import { makeRowShaper, type IssueRowData } from './issueRows';
import { listChildIssuesAction, listRootIssuesAction } from '../actions';

// The /issues TREE table (Subtask 2.5.3, made LAZY + SORTABLE in 2.5.14 for
// finding #57). The Server Component (IssueTreeSection) loads the FIRST page of
// ROOTS via the 2.5.13 read; this client wrapper fetches each node's children
// ON EXPAND (one level at a time) + "Load more children" past the per-node page,
// and the column headers SORT (re-reading via the sorted reads). It composes the
// generic TreeTable primitive (2.5.2) with the shared issue cells (issueColumns)
// — column-identical to the List. Sort lives in the URL (?sort=, like the List);
// a sort change REMOUNTS this component (keyed by sort in the parent), so the
// tree re-seeds from freshly-sorted roots. VIRTUALIZATION is its own 2.5.15.

/** Sentinel level key for the project roots (never a real work-item id). */
const ROOTS = '__roots__';

/** A node the TreeTable renders: a real issue, or a synthetic status row — the
 *  lazy "loading…" placeholder, or the "Load more children" affordance. */
type TreeNode =
  | { kind: 'issue'; row: IssueRowData }
  | { kind: 'loading' }
  | { kind: 'loadmore'; parentKey: string; loaded: number; total: number };

/** One lazily-loaded level: the accumulated rows + the level's full total. */
interface LevelState {
  rows: WorkItemTreeRowDto[];
  total: number;
  hasMore: boolean;
  loading: boolean;
}

export interface IssueTreeTableProps {
  /** The first page of project roots (from listRootIssues). */
  initialLevel: TreeLevelDto;
  sort: IssueSort;
  /** Preserved across a header-sort navigation (the filter applies to the Tree too). */
  filter: IssueFilter;
  /** Carried to the client so lazily-fetched levels shape identically to the roots. */
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
}

export function IssueTreeTable({
  initialLevel,
  sort,
  filter,
  workflow,
  members,
}: IssueTreeTableProps) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const sortParam = serializeSort(sort);
  const shape = useMemo(() => makeRowShaper(workflow, members), [workflow, members]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [levels, setLevels] = useState<Record<string, LevelState>>(() => ({
    [ROOTS]: {
      rows: initialLevel.rows,
      total: initialLevel.total,
      hasMore: initialLevel.hasMore,
      loading: false,
    },
  }));

  // Fetch one level (a parent's children, or more roots) and store / append it.
  const fetchLevel = useCallback(
    (parentId: string, offset: number, append: boolean) => {
      setLevels((prev) => ({
        ...prev,
        [parentId]: {
          rows: prev[parentId]?.rows ?? [],
          total: prev[parentId]?.total ?? 0,
          hasMore: prev[parentId]?.hasMore ?? false,
          loading: true,
        },
      }));
      startTransition(async () => {
        const result =
          parentId === ROOTS
            ? await listRootIssuesAction({ sortParam, offset })
            : await listChildIssuesAction({ parentId, sortParam, offset });
        setLevels((prev) => {
          const existing = prev[parentId];
          if (!result.ok) {
            return existing ? { ...prev, [parentId]: { ...existing, loading: false } } : prev;
          }
          const rows =
            append && existing ? [...existing.rows, ...result.level.rows] : result.level.rows;
          return {
            ...prev,
            [parentId]: {
              rows,
              total: result.level.total,
              hasMore: result.level.hasMore,
              loading: false,
            },
          };
        });
      });
    },
    [sortParam],
  );

  // Expanding a not-yet-loaded parent kicks its first children fetch.
  const onExpandedChange = useCallback(
    (next: Set<string>) => {
      for (const id of next) {
        if (!expanded.has(id) && !levels[id]) fetchLevel(id, 0, false);
      }
      setExpanded(next);
    },
    [expanded, levels, fetchLevel],
  );

  // "Load more children" (or more roots) — append the next page.
  const onRowActivate = useCallback(
    (_id: string, data: TreeNode) => {
      if (data.kind === 'loadmore') fetchLevel(data.parentKey, data.loaded, true);
    },
    [fetchLevel],
  );

  const onSort = useCallback(
    (column: IssueSortColumn) => {
      router.push(
        buildIssueListHref(pathname, { view: 'tree', sort: nextSort(sort, column), filter }),
      );
    },
    [router, pathname, sort, filter],
  );

  // Build the nested TreeTable model from the loaded levels + the expanded set.
  const rows = useMemo<TreeTableRow<TreeNode>[]>(() => {
    const buildLevel = (dtos: WorkItemTreeRowDto[], total: number): TreeTableRow<TreeNode>[] =>
      dtos.map((dto, i) => {
        const node: TreeTableRow<TreeNode> = {
          id: dto.id,
          data: { kind: 'issue', row: shape(dto) },
          hasChildren: dto.hasChildren,
          posinset: i + 1,
          setsize: total,
        };
        if (dto.hasChildren && expanded.has(dto.id)) {
          const lvl = levels[dto.id];
          if (!lvl || (lvl.loading && lvl.rows.length === 0)) {
            node.busy = true;
            node.children = [{ id: `${dto.id}::loading`, data: { kind: 'loading' } }];
          } else {
            node.busy = lvl.loading;
            const childRows = buildLevel(lvl.rows, lvl.total);
            node.children = lvl.hasMore
              ? [
                  ...childRows,
                  {
                    id: `${dto.id}::loadmore`,
                    data: {
                      kind: 'loadmore',
                      parentKey: dto.id,
                      loaded: lvl.rows.length,
                      total: lvl.total,
                    },
                  },
                ]
              : childRows;
          }
        }
        return node;
      });

    const root = levels[ROOTS] ?? { rows: [], total: 0, hasMore: false, loading: false };
    const rootRows = buildLevel(root.rows, root.total);
    return root.hasMore
      ? [
          ...rootRows,
          {
            id: `${ROOTS}::loadmore`,
            data: {
              kind: 'loadmore',
              parentKey: ROOTS,
              loaded: root.rows.length,
              total: root.total,
            },
          },
        ]
      : rootRows;
  }, [levels, expanded, shape]);

  // Columns: the shared issue cells, wrapped to (a) render synthetic status rows
  // in the tree column only, (b) make every header a sort button with aria-sort.
  const columns = useMemo<TreeTableColumn<TreeNode>[]>(
    () =>
      buildIssueColumns(t).map((col, idx) => {
        const isTree = idx === 0;
        const active = sort.column === col.sortColumn;
        const ariaSort: 'ascending' | 'descending' | 'none' = active
          ? sort.direction === 'asc'
            ? 'ascending'
            : 'descending'
          : 'none';
        return {
          key: col.key,
          align: col.align,
          ariaSort,
          headerLabel: col.header,
          header: (
            <SortHeader
              label={col.header}
              active={active}
              sort={sort}
              onSort={() => onSort(col.sortColumn)}
              alignEnd={col.align === 'end'}
            />
          ),
          cell: (node: TreeNode) => {
            if (node.kind === 'issue') return col.cell(node.row);
            if (!isTree) return null; // synthetic rows render only in the tree column
            if (node.kind === 'loading') {
              return (
                <span className="flex items-center gap-2 text-(--el-text-muted)">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Loading children…
                </span>
              );
            }
            return (
              <span className="relative z-10 flex items-center gap-1.5 text-(--el-link)">
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                Load more children
                <span className="text-(--el-text-faint)">
                  Showing {node.loaded} of {node.total}
                </span>
              </span>
            );
          },
        };
      }),
    [sort, onSort],
  );

  return (
    <TreeTable
      label={t('issues.list.tableLabel')}
      columns={columns}
      rows={rows}
      expandedIds={expanded}
      onExpandedChange={onExpandedChange}
      onRowActivate={onRowActivate}
      getRowHref={(node) => (node.kind === 'issue' ? `/issues/${node.row.identifier}` : undefined)}
      getRowLabel={(node) =>
        node.kind === 'issue' ? `${node.row.identifier} ${node.row.title}` : ''
      }
      getRowTestId={(node) =>
        node.kind === 'issue' ? `issue-row-${node.row.identifier}` : undefined
      }
    />
  );
}

/** A column-header sort button — the same affordance the List ships (caret
 *  hidden by default, faint on hover, solid on the active column). */
function SortHeader({
  label,
  active,
  sort,
  onSort,
  alignEnd,
}: {
  label: ReactNode;
  active: boolean;
  sort: IssueSort;
  onSort: () => void;
  alignEnd?: boolean;
}) {
  const Caret = active && sort.direction === 'desc' ? ChevronDown : ChevronUp;
  return (
    <button
      type="button"
      onClick={onSort}
      className={cn(
        'group/sort relative z-10 -ml-1 flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase hover:text-(--el-text)',
        'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
        alignEnd && '-mr-1 ml-auto flex-row-reverse',
      )}
    >
      <span className="truncate">{label}</span>
      <Caret
        className={cn(
          'h-3 w-3 shrink-0 transition-opacity',
          active
            ? 'text-(--el-text-secondary) opacity-100'
            : 'text-(--el-text-faint) opacity-0 group-hover/sort:opacity-100',
        )}
        aria-hidden
      />
    </button>
  );
}
