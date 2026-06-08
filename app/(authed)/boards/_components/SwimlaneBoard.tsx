'use client';

import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
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

// SwimlaneBoard (Subtask 3.3.5; load model corrected by 3.8.5) — the board
// re-laid into a grid of `(column × lane)` cells per
// `design/boards/swimlanes-wip.mock.html` + `board-scale.mock.html`, mounted by
// BoardContainer when `swimlaneGroupBy !== 'none'` (group-by `none` stays the
// flat 3.2 board). Structure mirrors the mock's `.swimboard`: a PINNED column-
// header row (`.colrow`) over one `.lane` per projection swimlane — a sticky-left
// `.lane-head` (label/kind + aggregate count + collapse chevron) above its
// `.lane-cols` row of `LaneCell`s.
//
// Load model (3.8.5, mistake #33): the board loads the WHOLE bounded set (the
// 3.8.2 projection — bounded by `BOARD_ISSUE_CAP`, with the over-cap banner in
// BoardContainer when `truncated`), so there is NO per-column "Load more" footer
// — the mirror product (Jira) never pages a board. Each `(lane, column)` cell
// renders its full bucket, virtualized per cell via `useRowWindow` (LaneCell,
// kept) so the DOM stays bounded on a tall cell.
//
// Lanes come from the projection's `swimlanes` (already ordered: assignee alpha
// / priority rank / epic position, catch-all LAST) and cards are bucketed by
// `swimlaneKey` (`bucketLanes`); per-lane aggregate counts + lane order are the
// projection's. Collapse is per-lane and persists client-side (localStorage
// keyed by board + lane). Columns align across the header row and every lane
// because all share the same cell width + gutter + gap. Colour via `--el-*`,
// shape via element tokens.
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
  onSetWipLimit,
  activeCardId,
  overLaneKey,
}: {
  boardId: string;
  columns: BoardColumnDto[];
  swimlanes: BoardSwimlaneDto[];
  assigneeNameById: Map<string, string>;
  onOpenQuickView: (identifier: string) => void;
  onSetWipLimit: (columnId: string, limit: number | null) => void;
  activeCardId: string | null;
  overLaneKey: string | null;
}) {
  const t = useTranslations('boards');
  const { collapsed, toggle } = useCollapsedLanes(boardId);
  const lanes = bucketLanes(columns, swimlanes);

  // Shared track classes so the pinned header row and every lane's cell row line
  // up column-for-column (same 288px cells + 14px gutter).
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
            // `min-w-max` so the lane row grows to the column-track width — without
            // it, the lane-header band collapses to the scroller's clientWidth and
            // stops at the viewport edge, leaving scrolled-into-view columns (e.g.
            // Cancelled) un-banded (epics.ts bug
            // `bug-swimlane-lane-header-not-spanning-scrolled-columns`).
            className="min-w-max border-b border-(--el-border) last:border-b-0"
          >
            {/*
             * Lane header — the BAND fills the full track (parent's `min-w-max`)
             * so it paints behind every column. The chevron + label + count are
             * wrapped in a separate `sticky left-6` element so they stay pinned
             * to the scroll-container's left edge (offset by the `px-6` page
             * gutter) as the user scrolls right; the BAND itself does not stick
             * (sticky on the band would have re-broken the bug). The outer div
             * is still the operable button (click/keys anywhere on the band
             * toggle collapse), which matches Jira/Linear.
             */}
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
              className={`cursor-pointer px-6 py-2.5 select-none ${
                isCatchAll
                  ? 'bg-(--el-muted) hover:bg-(--el-surface)'
                  : 'bg-(--el-surface-soft) hover:bg-(--el-surface)'
              }`}
            >
              <div
                className="sticky left-6 z-[2] inline-flex items-center gap-2.5"
                data-testid={`swimlane-headcontent-${lane.key}`}
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
              </div>
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
