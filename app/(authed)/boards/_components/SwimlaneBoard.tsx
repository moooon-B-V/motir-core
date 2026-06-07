'use client';

import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Spinner } from '@/components/ui/Spinner';
import { useCollapsedLanes } from '@/lib/hooks/useCollapsedLanes';
import {
  BOARD_SWIMLANE_NO_VALUE,
  type BoardColumnDto,
  type BoardSwimlaneDto,
} from '@/lib/dto/boards';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';
import { Avatar, PriorityValue } from '../../issues/_components/issueCellPrimitives';
import { ColumnActionsMenu } from './ColumnActionsMenu';
import { ColumnWipBadge } from './ColumnWipBadge';
import { LaneCell } from './LaneCell';
import { bucketLanes } from './boardSwimlanes';
import { columnHasMore } from './boardPaging';

// SwimlaneBoard (Subtask 3.3.5) — the board re-laid into a grid of
// `(column × lane)` cells per `design/boards/swimlanes-wip.mock.html`, mounted by
// BoardContainer when `swimlaneGroupBy !== 'none'` (group-by `none` stays the
// flat 3.2 board). Structure mirrors the mock's `.swimboard`: a PINNED column-
// header row (`.colrow`) over one `.lane` per projection swimlane — a sticky-left
// `.lane-head` (label/kind + aggregate count + collapse chevron) above its
// `.lane-cols` row of `LaneCell`s — then a per-column "Load more" footer.
//
// Lanes come from the projection's `swimlanes` (already ordered: assignee alpha
// / priority rank / epic position, catch-all LAST) and cards are bucketed by
// `swimlaneKey` (`bucketLanes`); per-lane aggregate counts + lane order are the
// projection's, the cards are the loaded page (a column's "load more" pages the
// rest, which re-buckets). Collapse is per-lane and persists client-side
// (localStorage keyed by board + lane). Columns align across the header row and
// every lane because all share the same cell width + gutter + gap. Colour via
// `--el-*`, shape via element tokens.
//
// The pinned column header reuses the SAME 3.3.6 WIP affordances as the flat
// board — `ColumnWipBadge` (the `n/limit` chip + SOFT over-limit warning) and
// `ColumnActionsMenu` (the `[⋯]` "Set WIP limit" editor) — so WIP config + the
// over-limit treatment work identically in both layouts. The WIP limit is the
// per-column total across all lanes (the projection's `totalCount`).

export function SwimlaneBoard({
  boardId,
  columns,
  swimlanes,
  assigneeNameById,
  onOpenQuickView,
  onLoadMore,
  onSetWipLimit,
  paging,
  activeCardId,
  overLaneKey,
}: {
  boardId: string;
  columns: BoardColumnDto[];
  swimlanes: BoardSwimlaneDto[];
  assigneeNameById: Map<string, string>;
  onOpenQuickView: (identifier: string) => void;
  onLoadMore: (columnId: string) => void;
  onSetWipLimit: (columnId: string, limit: number | null) => void;
  paging: Record<string, 'loading' | 'error'>;
  activeCardId: string | null;
  overLaneKey: string | null;
}) {
  const t = useTranslations('boards');
  const { collapsed, toggle } = useCollapsedLanes(boardId);
  const lanes = bucketLanes(columns, swimlanes);
  const anyMore = columns.some((c) => columnHasMore(c));

  // Shared track classes so the pinned header row, every lane's cell row, and the
  // load-more footer line up column-for-column (same 288px cells + 14px gutter).
  const track = 'flex min-w-max gap-3.5 px-6';

  return (
    <div
      data-testid="swimlane-board"
      className="overflow-x-auto pb-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      role="group"
      aria-label={t('boardLabel')}
      tabIndex={0}
    >
      {/* Pinned column-header row — counts are per-column TOTALS across all lanes. */}
      <div
        className={`${track} sticky top-0 z-[3] border-b border-(--el-border) bg-(--el-page-bg) py-2.5`}
      >
        {columns.map((column) => (
          <div key={column.id} className="flex w-72 shrink-0 items-center gap-2">
            <h2 className="text-[13px] font-semibold text-(--el-text-strong)">{column.name}</h2>
            <span
              className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) text-xs font-semibold text-(--el-text-secondary)"
              data-testid={`board-count-${column.id}`}
            >
              {column.totalCount}
            </span>
            <span className="flex-1" />
            {/* WIP chip + over-limit warning — the per-column total across lanes (3.3.6). */}
            <ColumnWipBadge
              columnId={column.id}
              totalCount={column.totalCount}
              wipLimit={column.wipLimit}
            />
            {/* The `[⋯]` menu hosting the WIP-limit editor (3.3.6). */}
            <ColumnActionsMenu
              columnId={column.id}
              wipLimit={column.wipLimit}
              onSetWipLimit={onSetWipLimit}
            />
          </div>
        ))}
      </div>

      {lanes.map(({ lane, cellsByColumnId }) => {
        const isCollapsed = collapsed.has(lane.key);
        const isDropTarget = overLaneKey === lane.key;
        const isCatchAll = lane.key === BOARD_SWIMLANE_NO_VALUE;
        return (
          <div
            key={lane.key}
            data-testid={`swimlane-${lane.key}`}
            className="border-b border-(--el-border) last:border-b-0"
          >
            {/* Sticky-left lane header — operable as a button (collapse/expand). */}
            <div
              role="button"
              tabIndex={0}
              aria-expanded={!isCollapsed}
              aria-label={t(isCollapsed ? 'laneExpand' : 'laneCollapse', {
                label: lane.label,
                count: lane.count,
              })}
              data-testid={`swimlane-head-${lane.key}`}
              onClick={() => toggle(lane.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle(lane.key);
                }
              }}
              className={`sticky left-0 z-[2] flex w-full cursor-pointer items-center gap-2.5 px-6 py-2.5 select-none ${
                isCatchAll
                  ? 'bg-(--el-muted) hover:bg-(--el-surface)'
                  : 'bg-(--el-surface-soft) hover:bg-(--el-surface)'
              }`}
            >
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-(--el-text-muted) transition-transform ${
                  isCollapsed ? '-rotate-90' : ''
                }`}
                aria-hidden
              />
              <LaneLabel lane={lane} isCatchAll={isCatchAll} />
              <span
                className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) text-[11px] font-semibold text-(--el-text-secondary)"
                data-testid={`swimlane-count-${lane.key}`}
              >
                {lane.count}
              </span>
              <span className="flex-1" />
            </div>

            {!isCollapsed ? (
              <div
                className={`${track} py-2 ${
                  isDropTarget
                    ? 'rounded-(--radius-card) bg-(--el-tint-lavender) outline outline-2 outline-(--el-accent)'
                    : ''
                }`}
              >
                {columns.map((column) => (
                  <LaneCell
                    key={column.id}
                    columnId={column.id}
                    laneKey={lane.key}
                    cards={cellsByColumnId.get(column.id) ?? []}
                    assigneeNameById={assigneeNameById}
                    onOpenQuickView={onOpenQuickView}
                    activeCardId={activeCardId}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      {/* Per-column "Load more" footer (finding #57 — cards page per column, then
          re-bucket into lanes; no all-cards fetch). Mirrors the header track so
          each control sits under its column. */}
      {anyMore ? (
        <div className={`${track} pt-2`}>
          {columns.map((column) => {
            const more = columnHasMore(column);
            const state = paging[column.id];
            return (
              <div key={column.id} className="w-72 shrink-0">
                {more ? (
                  <button
                    type="button"
                    onClick={() => onLoadMore(column.id)}
                    disabled={state === 'loading'}
                    data-testid={`board-load-more-${column.id}`}
                    className="flex h-(--height-control) w-full items-center justify-center gap-1.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-page-bg) text-[13px] font-medium text-(--el-text-secondary) hover:border-(--el-border-strong) disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {state === 'loading' ? (
                      <>
                        <Spinner size="sm" aria-label={t('loadingMore')} />
                        {t('loadingMore')}
                      </>
                    ) : state === 'error' ? (
                      t('loadMoreRetry')
                    ) : (
                      t('loadMore')
                    )}
                  </button>
                ) : null}
                {state === 'error' ? (
                  <p className="pt-1 text-center text-xs text-(--el-danger)">
                    {t('loadMoreError')}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** The lane header's group label, rendered by dimension (mock: `.lane-label`). */
function LaneLabel({ lane, isCatchAll }: { lane: BoardSwimlaneDto; isCatchAll: boolean }) {
  if (isCatchAll) {
    return (
      <span className="inline-flex items-center gap-2 text-[13px] font-medium text-(--el-text-muted)">
        <span
          className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-dashed border-(--el-border-strong) bg-(--el-muted) text-[10px] text-(--el-text-faint)"
          aria-hidden
        >
          –
        </span>
        {lane.label}
      </span>
    );
  }
  if (lane.kind === 'priority') {
    return (
      <span className="inline-flex items-center text-[13px] font-semibold text-(--el-text-strong)">
        <PriorityValue priority={lane.key as WorkItemPriorityDto} />
      </span>
    );
  }
  if (lane.kind === 'epic') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-(--el-text-strong)">
        <IssueTypeIcon type="epic" className="h-4 w-4 shrink-0" />
        {lane.label}
      </span>
    );
  }
  // assignee
  return (
    <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-(--el-text-strong)">
      <Avatar name={lane.label} />
      {lane.label}
    </span>
  );
}
