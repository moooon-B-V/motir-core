'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, EyeOff, Loader2, Lock } from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import { TreeTable, type TreeTableColumn, type TreeTableRow } from '@/components/ui/TreeTable';
import { cn } from '@/lib/utils/cn';
import type { PublicTreeLevelDto, PublicWorkItemTreeRowDto } from '@/lib/dto/publicProjects';
import type { StatusCategoryDto } from '@/lib/dto/workflows';

// The PUBLIC, read-only, expandable work-item TREE (Story 6.14 · Subtask
// 6.14.10) — the hierarchical surface 6.14.5 / 6.14.6 / 6.14.9 assume. Client
// island: the Server Component (the Tree tab page) SSRs the FIRST page of roots
// (crawlable); this wrapper fetches each node's children ON EXPAND, one level at
// a time, + "Load more children" past the per-level page (the at-scale rule —
// never load the whole forest). It composes the generic TreeTable primitive
// (2.5.2 — the WAI-ARIA treegrid + virtualization) with the PUBLIC projection
// (no assignee / estimate / story points — those never cross the wire).
//
// Epic privacy (6.14.4 / design epic-privacy panel 1+2): a PRIVATE epic's row
// stays visible (kind icon + key + title + a "Not public" badge) but its
// descendants are EXCLUDED server-side; expanding it renders the inline "This
// epic is not public" placeholder INSTEAD of children, driven by the row's
// `childrenHidden` marker — no child fetch is issued. A project member reads the
// full tree (no marker, real children). Read-only: no sort headers, no inline
// edit, rows are not links (there is no public work-item detail route in 6.12).

/** Sentinel level key for the project roots (never a real work-item id). */
const ROOTS = '__roots__';

/** A node the TreeTable renders: a real public item, or a synthetic row — the
 *  lazy "loading…" placeholder, the epic-privacy "not public" placeholder, or
 *  the "Load more children" affordance. */
type TreeNode =
  | { kind: 'item'; row: PublicWorkItemTreeRowDto }
  | { kind: 'loading' }
  | { kind: 'private' }
  | { kind: 'loadmore'; parentKey: string; loaded: number; total: number };

/** One lazily-loaded level: the accumulated rows + the level's full total. */
interface LevelState {
  rows: PublicWorkItemTreeRowDto[];
  total: number;
  hasMore: boolean;
  loading: boolean;
}

const PRIORITY_PILL: Record<
  PublicWorkItemTreeRowDto['priority'],
  { tone: 'high' | 'medium' | 'low'; key: string }
> = {
  highest: { tone: 'high', key: 'priorityHighest' },
  high: { tone: 'high', key: 'priorityHigh' },
  medium: { tone: 'medium', key: 'priorityMedium' },
  low: { tone: 'low', key: 'priorityLow' },
  lowest: { tone: 'low', key: 'priorityLowest' },
};

const STATUS_PILL: Record<
  StatusCategoryDto,
  { variant: 'planned' | 'in-progress' | 'done'; key: string }
> = {
  todo: { variant: 'planned', key: 'statusTodo' },
  in_progress: { variant: 'in-progress', key: 'statusInProgress' },
  done: { variant: 'done', key: 'statusDone' },
};

export function PublicWorkItemTree({
  identifier,
  initialLevel,
}: {
  identifier: string;
  initialLevel: PublicTreeLevelDto;
}) {
  const t = useTranslations('publicProjects');

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
  // Reads the anonymous public tree endpoint (no session needed) — the at-scale
  // lazy read. A failed fetch clears the loading flag and leaves the level as-is.
  const fetchLevel = useCallback(
    async (parentId: string, offset: number, append: boolean) => {
      setLevels((prev) => ({
        ...prev,
        [parentId]: {
          rows: prev[parentId]?.rows ?? [],
          total: prev[parentId]?.total ?? 0,
          hasMore: prev[parentId]?.hasMore ?? false,
          loading: true,
        },
      }));
      const params = new URLSearchParams();
      if (parentId !== ROOTS) params.set('parentId', parentId);
      if (offset > 0) params.set('offset', String(offset));
      const qs = params.toString();
      const url = `/api/public/p/${encodeURIComponent(identifier)}/tree${qs ? `?${qs}` : ''}`;
      let level: PublicTreeLevelDto | null = null;
      try {
        const res = await fetch(url);
        if (res.ok) level = (await res.json()) as PublicTreeLevelDto;
      } catch {
        level = null;
      }
      setLevels((prev) => {
        const existing = prev[parentId];
        if (!level) {
          return existing ? { ...prev, [parentId]: { ...existing, loading: false } } : prev;
        }
        const rows = append && existing ? [...existing.rows, ...level.rows] : level.rows;
        return {
          ...prev,
          [parentId]: { rows, total: level.total, hasMore: level.hasMore, loading: false },
        };
      });
    },
    [identifier],
  );

  // Expanding a not-yet-loaded REAL parent kicks its first children fetch. A
  // private epic (childrenHidden, no real children loaded) is expanded WITHOUT a
  // fetch — its placeholder is injected synthetically below.
  const onExpandedChange = useCallback(
    (next: Set<string>) => {
      const rowById = new Map<string, PublicWorkItemTreeRowDto>();
      for (const lvl of Object.values(levels)) for (const r of lvl.rows) rowById.set(r.id, r);
      for (const id of next) {
        if (expanded.has(id)) continue;
        const row = rowById.get(id);
        if (row?.childrenHidden) continue; // placeholder is synthetic — no fetch
        if (row?.hasChildren && !levels[id]) void fetchLevel(id, 0, false);
      }
      setExpanded(next);
    },
    [expanded, levels, fetchLevel],
  );

  // "Load more children" (or more roots) — append the next page.
  const onRowActivate = useCallback(
    (_id: string, data: TreeNode) => {
      if (data.kind === 'loadmore') void fetchLevel(data.parentKey, data.loaded, true);
    },
    [fetchLevel],
  );

  // Build the nested TreeTable model from the loaded levels + the expanded set.
  const rows = useMemo<TreeTableRow<TreeNode>[]>(() => {
    const buildLevel = (
      dtos: PublicWorkItemTreeRowDto[],
      total: number,
    ): TreeTableRow<TreeNode>[] =>
      dtos.map((dto, i) => {
        // A private epic is "expandable" via its marker even though it has no
        // public children; a real parent via `hasChildren`.
        const expandable = dto.hasChildren || !!dto.childrenHidden;
        const node: TreeTableRow<TreeNode> = {
          id: dto.id,
          data: { kind: 'item', row: dto },
          hasChildren: expandable,
          posinset: i + 1,
          setsize: total,
        };
        if (!expandable || !expanded.has(dto.id)) return node;

        if (dto.childrenHidden) {
          // Epic-privacy: one inline "not public" placeholder, no fetch.
          node.children = [{ id: `${dto.id}::private`, data: { kind: 'private' } }];
          return node;
        }
        const lvl = levels[dto.id];
        if (!lvl || (lvl.loading && lvl.rows.length === 0)) {
          node.busy = true;
          node.children = [{ id: `${dto.id}::loading`, data: { kind: 'loading' } }];
          return node;
        }
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
  }, [levels, expanded]);

  const columns = useMemo<TreeTableColumn<TreeNode>[]>(
    () => [
      {
        key: 'title',
        header: t('treeColTitle'),
        cell: (node: TreeNode) => {
          if (node.kind === 'item') return <TitleCell row={node.row} t={t} />;
          if (node.kind === 'loading') {
            return (
              <span className="flex items-center gap-2 text-(--el-text-muted)">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                {t('treeLoadingChildren')}
              </span>
            );
          }
          if (node.kind === 'private') return <PrivatePlaceholder t={t} />;
          return (
            <span className="relative z-10 flex items-center gap-1.5 text-(--el-link)">
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              {t('treeLoadMoreChildren')}
              <span className="text-(--el-text-faint)">
                {t('treeShowingCount', { loaded: node.loaded, total: node.total })}
              </span>
            </span>
          );
        },
      },
      {
        key: 'status',
        header: t('treeColStatus'),
        width: 150,
        cell: (node: TreeNode) => {
          if (node.kind !== 'item') return null;
          const s = STATUS_PILL[node.row.statusCategory];
          return <Pill status={s.variant}>{t(s.key)}</Pill>;
        },
      },
      {
        key: 'priority',
        header: t('treeColPriority'),
        width: 120,
        cell: (node: TreeNode) => {
          if (node.kind !== 'item') return null;
          const pri = PRIORITY_PILL[node.row.priority];
          return (
            <Pill
              tone="neutral"
              className={cn(
                'border-transparent text-(--el-text-strong)',
                pri.tone === 'high' && 'bg-(--el-tint-rose)',
                pri.tone === 'medium' && 'bg-(--el-tint-yellow)',
                pri.tone === 'low' &&
                  'border-(--el-border) bg-(--el-surface) text-(--el-text-secondary)',
              )}
            >
              {t(pri.key)}
            </Pill>
          );
        },
      },
    ],
    [t],
  );

  return (
    <TreeTable
      label={t('treeTitle')}
      columns={columns}
      rows={rows}
      expandedIds={expanded}
      onExpandedChange={onExpandedChange}
      onRowActivate={onRowActivate}
      getRowTestId={(node) =>
        node.kind === 'item' ? `public-tree-row-${node.row.identifier}` : undefined
      }
    />
  );
}

/** The tree column for a real item: kind icon + key + title + (private) badge. */
function TitleCell({
  row,
  t,
}: {
  row: PublicWorkItemTreeRowDto;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <IssueTypeIcon type={row.kind} className="h-4 w-4 flex-none" />
      <span className="font-mono text-[11.5px] text-(--el-text-faint)">{row.identifier}</span>
      <span className="min-w-0 truncate text-[13.5px] font-medium text-(--el-text)">
        {row.title}
      </span>
      {row.childrenHidden ? (
        <Pill
          tone="neutral"
          className="flex-none gap-1 border-transparent bg-(--el-tint-lavender) text-(--el-text-strong)"
        >
          <Lock className="h-3 w-3" aria-hidden />
          {t('epicNotPublicBadge')}
        </Pill>
      ) : null}
    </span>
  );
}

/** The epic-privacy tree-expand placeholder (design epic-privacy panel 2) — the
 *  inline "This epic is not public" row that replaces a private epic's children
 *  for a public / non-member viewer. */
function PrivatePlaceholder({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <span className="flex items-start gap-2.5 rounded-(--radius-control) bg-(--el-surface-soft) px-3 py-2">
      <EyeOff className="mt-0.5 h-4 w-4 flex-none text-(--el-text-muted)" aria-hidden />
      <span className="flex flex-col">
        <span className="text-[13px] font-semibold text-(--el-text)">
          {t('epicNotPublicTitle')}
        </span>
        <span className="text-[12.5px] text-(--el-text-secondary)">{t('epicNotPublicBody')}</span>
      </span>
    </span>
  );
}
