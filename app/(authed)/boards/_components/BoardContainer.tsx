'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Flag, LayoutGrid, User, Zap } from 'lucide-react';
import { ErrorState } from '@/components/ui/ErrorState';
import { Segmented } from '@/components/ui/Segmented';
import { useToast } from '@/components/ui/Toast';
import type {
  BoardCardDto,
  BoardColumnConfigDto,
  BoardColumnDto,
  BoardProjectionDto,
  BoardSwimlaneGroupByDto,
} from '@/lib/dto/boards';
import type { MoveCardResultDto } from '@/lib/dto/boards';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { useCreateIssue } from '../../_components/CreateIssueProvider';
import { usePeekOpen } from '../../issues/_components/IssueQuickView';
import { updateIssueAction } from '../../issues/[key]/edit/actions';
import { BoardCardOverlay } from './BoardCard';
import { BoardColumn } from './BoardColumn';
import { BoardColumnPager, useActiveColumnIndex } from './BoardColumnPager';
import { BoardEmptyState } from './BoardEmptyState';
import { BoardSkeleton } from './BoardSkeleton';
import { OverCapBanner } from './OverCapBanner';
import { SwimlaneBoard } from './SwimlaneBoard';
import { UnmappedStatusesTray } from './UnmappedStatusesTray';
import {
  cardIndex,
  columnOfOverId,
  findCard,
  findCardColumnId,
  neighborsOf,
  reconcileCard,
  relocateCard,
  transferCount,
} from './boardMove';
import {
  cellOfOverId,
  laneKeyOfCard,
  moveCardToColumn,
  parseCellId,
  reassignPatchForLane,
  relocateCardToCell,
  resolveCellMove,
  setCardSwimlaneKey,
} from './boardSwimlanes';

// The board client container (Subtask 3.2.2 · drag-drop 3.2.4 · scale 3.2.5 ·
// swimlanes + WIP 3.3). A PURE CONSUMER of the Story-3.1/3.3 board API: it
// fetches `GET /api/board` (the active project's default board) on mount and
// renders the board-level states from `design/boards/board.mock.html` (panel 6).
//
// Story 3.3.5 adds the swimlane layer ON TOP, without forking the board: a
// board-header **group-by control** (the 3.2.1-reserved 3.3-controls slot) that
// PATCHes `board.swimlaneGroupBy` (3.3.3) and RE-LAYS from the projection (a
// loading transition, never a flash of the old layout); when the group-by is
// `none` the flat 3.2 column row renders unchanged, otherwise `SwimlaneBoard`
// renders the `(column × lane)` grid. There is NO data access here beyond the
// board fetch, the move POST, the group-by PATCH, the WIP-config PATCH, and the
// existing 2.5 field-update action the cross-lane drag reuses — no new route.
//
// State shape: the projection lives in component state as `board`, with its
// `columns[].cards` arrays held so the later subtasks can mutate ONE column's
// card list in place (3.2.4 optimistic moves, 3.2.5 appended pages) without
// refetching the whole board.
//
// Completeness (Subtask 3.2.6): an all-empty board renders the board EMPTY
// state (a "New work item" CTA, not six blank columns); `unmappedStatuses`
// renders the unmapped-statuses TRAY above the board; and the flat column row is
// a scroll-snap single-column pager on narrow viewports — see `BoardDnd`.
//
// `members` (the workspace member directory the board page already resolves) lets
// the cards map each `BoardCardDto.assigneeId` to a display name for the avatar —
// the projection card carries only the id (Story 3.1.4).
//
// `activeProjectId` is the currently-active project (resolved server-side from
// `WorkspaceMembership.activeProjectId`). The board is client-fetched, so when
// the user switches project/workspace — which persists the new active project and
// calls `router.refresh()` (Server Components only) — the board would otherwise
// stay on the OLD project's data. Passing the id as a prop and watching it lets
// the refresh re-render the page with the new id, which re-runs the fetch.

type BoardStatus = 'loading' | 'ready' | 'error' | 'no-board';

export function BoardContainer({
  members = [],
  activeProjectId,
}: {
  members?: WorkspaceMemberDTO[];
  activeProjectId?: string;
}) {
  const t = useTranslations('boards');
  const { toast } = useToast();
  // The selected board (Subtask 3.7.4) — the switcher writes `?board=<id>`; we
  // read it and re-fetch the projection for that board. The GET resolves the
  // board id server-side in Subtask 3.7.5 (until then it returns the project's
  // default board regardless, so the switch updates the URL + refetches but the
  // projection is the default's — the switcher UI is complete on its own).
  const searchParams = useSearchParams();
  const selectedBoardId = searchParams?.get('board') ?? null;
  // The group-by control lives in the PAGE HEADER toolbar row (beside the board
  // switcher), per design/boards/multi-board.mock.html — but its value + change
  // handler live HERE (in the projection state). page.tsx renders an empty
  // `display:contents` slot in that row; we portal the GroupByControl into it so
  // the control sits in the header while its state stays with the board. (In an
  // isolated unit render with no page header, the slot is absent → the portal
  // renders nothing, which is fine — the E2E covers the real header.)
  // Capture the header group-by slot AFTER mount (an effect, NOT a lazy useState
  // initializer): on a CLIENT navigation to /boards the slot is rendered in the
  // SAME commit as this component, so it isn't in the DOM yet during the first
  // render — a render-time lookup returns null and the portal never mounts (the
  // group-by control vanishes). The effect runs post-commit, when the sibling
  // slot exists, on both first load and client nav.
  const [groupBySlot, setGroupBySlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- capturing a portal target that commits in the same render pass; it must be read post-commit, which is exactly what an effect is for (DOM sync)
    setGroupBySlot(document.getElementById('board-toolbar-groupby-slot'));
  }, []);
  const [board, setBoard] = useState<BoardProjectionDto | null>(null);
  const [status, setStatus] = useState<BoardStatus>('loading');
  // 'relaying' = a group-by change is fetching the new projection; the toolbar
  // stays mounted (so the control is still visible) while the grid shows the
  // skeleton — the re-lay loading transition, not a flash of the old layout.
  const [relaying, setRelaying] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Bumped on every successful fetch so the interactive `BoardDnd` (whose column
  // state seeds from the projection only on mount) RE-SEEDS — keying it by this
  // remounts it with the fresh projection after a refetch (e.g. a create), so a
  // new card actually appears instead of the stale local state lingering.
  const [boardVersion, setBoardVersion] = useState(0);

  // A create (the empty-state CTA, or any "+ New" while the board is open) goes
  // through the shell's CreateIssueProvider. The board is client-fetched, so
  // `router.refresh()` (which only re-runs Server Components) does NOT refresh
  // it — instead we watch the provider's `issuesChangedAt` tick and refetch.
  // Fixes: creating from the empty state left the board stuck on "No work items".
  const { issuesChangedAt } = useCreateIssue();

  useEffect(() => {
    let active = true;
    const url = selectedBoardId
      ? `/api/board?boardId=${encodeURIComponent(selectedBoardId)}`
      : '/api/board';
    fetch(url, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as BoardProjectionDto;
          if (!active) return;
          setBoard(data);
          setBoardVersion((v) => v + 1);
          setStatus('ready');
          return;
        }
        let code: string | undefined;
        try {
          code = ((await res.json()) as { code?: string }).code;
        } catch {
          code = undefined;
        }
        if (!active) return;
        setStatus(res.status === 404 && code === 'BOARD_NOT_FOUND' ? 'no-board' : 'error');
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
    // `activeProjectId` is in the deps so switching project/workspace (→ a new
    // active project + router.refresh()) re-runs the fetch for the new project's
    // board instead of leaving the previous project's board on screen.
    // `selectedBoardId` is in the deps so the 3.7.4 switcher's `?board=<id>`
    // change re-fetches that board's projection (re-lay; 3.7.5 wires the server
    // resolution of the id).
  }, [reloadKey, issuesChangedAt, activeProjectId, selectedBoardId]);

  const retry = useCallback(() => {
    setStatus('loading');
    setReloadKey((k) => k + 1);
  }, []);

  // Change the swimlane group-by: persist it (PATCH, 3.3.3) so every viewer
  // shares it, then refetch the projection and re-lay. The grid drops to the
  // skeleton during the round-trip; on failure the old board stays and a toast
  // explains. The active value is always read from the projection (never local).
  const changeGroupBy = useCallback(
    async (next: BoardSwimlaneGroupByDto) => {
      if (!board || next === board.swimlaneGroupBy) return;
      setRelaying(true);
      try {
        const patch = await fetch('/api/board', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ boardId: board.boardId, swimlaneGroupBy: next }),
        });
        if (!patch.ok) throw new Error(`group-by ${patch.status}`);
        const res = await fetch('/api/board', { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`reload ${res.status}`);
        setBoard((await res.json()) as BoardProjectionDto);
      } catch {
        toast({
          variant: 'error',
          title: t('groupByErrorTitle'),
          description: t('groupByErrorDescription'),
        });
      } finally {
        setRelaying(false);
      }
    },
    [board, t, toast],
  );

  const assigneeNameById = useMemo(
    () => new Map(members.map((m) => [m.userId, m.name || m.email])),
    [members],
  );

  if (status === 'loading') return <BoardSkeleton />;
  if (status === 'no-board') {
    return (
      <ErrorState title={t('noBoardTitle')} description={t('noBoardDescription')} retry={retry} />
    );
  }
  if (status === 'error' || !board) {
    return <ErrorState title={t('errorTitle')} description={t('errorDescription')} retry={retry} />;
  }

  // Completeness states (Subtask 3.2.6) are derived from the freshly-FETCHED
  // projection (not BoardDnd's local drag state), so a refetch updates them
  // immediately:
  //   - unmapped-statuses TRAY above the board (absent when all are mapped);
  //   - the board EMPTY state when every column is empty AND nothing is unmapped
  //     (when statuses are unmapped, work items may be hidden in them — present,
  //     not absent — so we keep the columns + tray rather than claim "no work
  //     items"; rung-2 guard). An empty board has nothing to group, so the
  //     group-by control is omitted there (the CTA is the focus).
  const hasUnmapped = board.unmappedStatuses.length > 0;
  const isEmpty = !hasUnmapped && board.columns.every((c) => c.totalCount === 0);

  // The over-cap banner (Subtask 3.8.4) is a board-level signal, so it sits
  // ABOVE both layouts in the container (like the unmapped tray) and shows for
  // the flat AND swimlane board — rendered exactly when the 3.8.2 projection's
  // bounded load hit the cap (`truncated`). An over-cap board always has cards,
  // so this never coincides with the empty state.
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* The group-by control is portaled into the header toolbar slot (beside the
          switcher) — the design row, not a separate body row. Shown only for a
          non-empty board (an empty board has nothing to group); stays visible
          while a group-by change re-lays (`disabled={relaying}`). */}
      {!isEmpty && groupBySlot
        ? createPortal(
            <GroupByControl
              value={board.swimlaneGroupBy}
              onChange={changeGroupBy}
              disabled={relaying}
            />,
            groupBySlot,
          )
        : null}
      {board.truncated ? <OverCapBanner cap={board.cap} /> : null}
      {hasUnmapped ? <UnmappedStatusesTray statuses={board.unmappedStatuses} /> : null}
      {isEmpty ? (
        <BoardEmptyState />
      ) : relaying ? (
        <BoardSkeleton />
      ) : (
        // Key by `boardVersion` (re-seed BoardDnd's mount-seeded column state
        // after a refetch — e.g. a create shows the new card) AND by the
        // group-by (a group-by change remounts with the fresh lane layout
        // rather than reconciling across layouts).
        <BoardDnd
          key={`${boardVersion}:${board.swimlaneGroupBy}`}
          board={board}
          assigneeNameById={assigneeNameById}
        />
      )}
    </div>
  );
}

// The board-header group-by control (3.3.5) — the shipped Segmented primitive in
// the 3.2.1-reserved 3.3-controls slot. None = the flat 3.2 board.
function GroupByControl({
  value,
  onChange,
  disabled,
}: {
  value: BoardSwimlaneGroupByDto;
  onChange: (v: BoardSwimlaneGroupByDto) => void;
  disabled: boolean;
}) {
  const t = useTranslations('boards');
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-(--el-text-muted)">{t('groupByLabel')}</span>
      <Segmented<BoardSwimlaneGroupByDto>
        label={t('groupByAria')}
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={[
          { value: 'none', label: t('groupByNone'), icon: <LayoutGrid /> },
          { value: 'assignee', label: t('groupByAssignee'), icon: <User /> },
          { value: 'epic', label: t('groupByEpic'), icon: <Zap /> },
          { value: 'priority', label: t('groupByPriority'), icon: <Flag /> },
        ]}
      />
    </div>
  );
}

// The interactive board (Subtask 3.2.4 · swimlanes 3.3.5) — a dnd-kit
// `DndContext` over EITHER the flat 3.2 column row (group-by `none`) or the
// `SwimlaneBoard` grid (group-by ≠ `none`). It owns the mutable `columns` state
// (seeded from the projection); each card carries its resolved `swimlaneKey`
// (3.3.4), so the lane a card sits in is derived, never re-computed.
//
// FLAT drop (3.2.4, unchanged): a cross-column drop is a workflow TRANSITION
// (`POST /api/board/move`); 200 reconciles, 409/422/error snaps back + toasts.
//
// SWIMLANE drop (3.3.5): a drop resolves a target COLUMN and a target LANE.
//   - column change → the SAME 3.2 transition (`/board/move`).
//   - lane change   → reassign the grouped field via the EXISTING 2.5
//     `updateIssueAction` (assignee / priority / epic-reparent; the catch-all
//     clears it) — NOT the move endpoint, NO new backend.
//   - a diagonal drop applies BOTH writes, each optimistic with INDEPENDENT
//     snap-back: a rejected transition reverts only the column axis, a rejected
//     reassign reverts only the lane axis — the card never rests in a lying
//     position.
function BoardDnd({
  board,
  assigneeNameById,
}: {
  board: BoardProjectionDto;
  assigneeNameById: Map<string, string>;
}) {
  const t = useTranslations('boards');
  const { toast } = useToast();
  const openPeek = usePeekOpen();
  const groupBy = board.swimlaneGroupBy;
  const swimlaned = groupBy !== 'none';

  const [columns, setColumns] = useState<BoardColumnDto[]>(board.columns);
  const [activeCard, setActiveCard] = useState<BoardCardDto | null>(null);
  // The lane currently under the drag (swimlane mode) — drives the target-lane
  // ring/tint (paired with the cell `isOver` outline; never colour-alone, #35).
  const [overLaneKey, setOverLaneKey] = useState<string | null>(null);

  // The horizontal scroll region (the flat column row) + which column is centred
  // in it — drives the mobile pager (Subtask 3.2.6, design panel 7). On a narrow
  // viewport the flat board reads as a single-column scroll; the pager shows
  // "{name} · {i} of {n}". (Swimlane mode has its own scroll container.)
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeColumn = useActiveColumnIndex(scrollRef, columns.length);

  // A mirror ref so the drag handlers read the LATEST columns synchronously
  // (a dnd lifecycle event can fire before a state update has re-rendered),
  // and a snapshot of the columns at pick-up for the snap-back on rejection.
  // The mirror is kept in sync via a LAYOUT effect (writing a ref during render
  // is forbidden) — a layout effect flushes synchronously at commit, before the
  // next pointer/keyboard drag event, so each handler reads the prior event's
  // committed columns (a passive effect could lag a fast move→drop). BoardDnd
  // only mounts client-side (the ready branch), so there is no SSR warning.
  const columnsRef = useRef(columns);
  useLayoutEffect(() => {
    columnsRef.current = columns;
  }, [columns]);
  const snapshotRef = useRef<BoardColumnDto[] | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );

  const colName = useCallback(
    (cols: BoardColumnDto[], colId: string | null) => cols.find((c) => c.id === colId)?.name ?? '',
    [],
  );
  const laneLabel = useCallback(
    (key: string) => board.swimlanes.find((l) => l.key === key)?.label ?? key,
    [board.swimlanes],
  );

  const snapBack = useCallback(
    (snapshot: BoardColumnDto[], description: string) => {
      setColumns(snapshot);
      toast({ variant: 'error', title: t('moveRejectedTitle'), description });
    },
    [t, toast],
  );

  // FLAT-mode move (3.2.4) — full-snapshot revert (no lane axis to isolate).
  const runMove = useCallback(
    async (args: {
      workItemId: string;
      toColumnId: string;
      beforeId?: string;
      afterId?: string;
      snapshot: BoardColumnDto[];
      card: BoardCardDto;
      fromColName: string;
      toColName: string;
    }) => {
      try {
        const res = await fetch('/api/board/move', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            boardId: board.boardId,
            workItemId: args.workItemId,
            toColumnId: args.toColumnId,
            beforeId: args.beforeId,
            afterId: args.afterId,
          }),
        });
        if (res.ok) {
          const result = (await res.json()) as MoveCardResultDto;
          setColumns((prev) => reconcileCard(prev, result.card));
          return;
        }
        const key = args.card.identifier;
        if (res.status === 409) {
          snapBack(
            args.snapshot,
            t('moveIllegalDescription', { from: args.fromColName, to: args.toColName, key }),
          );
        } else if (res.status === 422) {
          snapBack(args.snapshot, t('moveUnmappedDescription', { to: args.toColName, key }));
        } else {
          snapBack(args.snapshot, t('moveErrorDescription', { key }));
        }
      } catch {
        snapBack(args.snapshot, t('moveErrorDescription', { key: args.card.identifier }));
      }
    },
    [board.boardId, snapBack, t],
  );

  // SWIMLANE transition (column axis) — INDEPENDENT revert: on rejection, move
  // the card back to its origin column (keeping any accepted lane reassign) and
  // undo the optimistic count, rather than restoring the whole snapshot.
  const runTransition = useCallback(
    async (args: {
      workItemId: string;
      originColId: string;
      targetColId: string;
      beforeId?: string;
      afterId?: string;
      card: BoardCardDto;
      fromColName: string;
      toColName: string;
    }) => {
      const revert = () => {
        setColumns((prev) =>
          transferCount(
            moveCardToColumn(prev, args.workItemId, args.originColId),
            args.targetColId,
            args.originColId,
          ),
        );
      };
      try {
        const res = await fetch('/api/board/move', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            boardId: board.boardId,
            workItemId: args.workItemId,
            toColumnId: args.targetColId,
            beforeId: args.beforeId,
            afterId: args.afterId,
          }),
        });
        if (res.ok) {
          const result = (await res.json()) as MoveCardResultDto;
          // Keep the optimistic swimlaneKey (the reassign axis owns it); take the
          // server's confirmed status / position / ready.
          setColumns((prev) =>
            reconcileCard(prev, { ...result.card, swimlaneKey: laneKeyOfCard(args.card) }),
          );
          return;
        }
        const key = args.card.identifier;
        revert();
        const description =
          res.status === 409
            ? t('moveIllegalDescription', { from: args.fromColName, to: args.toColName, key })
            : res.status === 422
              ? t('moveUnmappedDescription', { to: args.toColName, key })
              : t('moveErrorDescription', { key });
        toast({ variant: 'error', title: t('moveRejectedTitle'), description });
      } catch {
        revert();
        toast({
          variant: 'error',
          title: t('moveRejectedTitle'),
          description: t('moveErrorDescription', { key: args.card.identifier }),
        });
      }
    },
    [board.boardId, t, toast],
  );

  // SWIMLANE reassign (lane axis) — reuses the EXISTING 2.5 field-update action.
  // INDEPENDENT revert: on rejection, restore only the card's `swimlaneKey` to
  // its origin lane (any accepted transition stays).
  const runReassign = useCallback(
    async (args: {
      workItemId: string;
      originLaneKey: string;
      targetLaneKey: string;
      card: BoardCardDto;
    }) => {
      const result = await updateIssueAction({
        id: args.workItemId,
        ...reassignPatchForLane(groupBy, args.targetLaneKey),
      });
      if (!result.ok) {
        setColumns((prev) => setCardSwimlaneKey(prev, args.workItemId, args.originLaneKey));
        toast({
          variant: 'error',
          title: t('reassignRejectedTitle'),
          description: result.error || t('reassignErrorDescription', { key: args.card.identifier }),
        });
      }
    },
    [groupBy, t, toast],
  );

  // Set or clear a column's WIP limit (Subtask 3.3.6) — the optimistic config
  // write the `[⋯]` menu's "Set WIP limit" editor triggers. Apply the new
  // `wipLimit` to the column immediately, PATCH `…/board/columns/[id]` (3.3.3),
  // then reconcile to the returned column DTO; on any failure revert to the
  // pre-edit snapshot and toast. Config only — it never touches a card's
  // column/position, so the 3.2.4 move contract is unaffected (WIP is a SOFT,
  // advisory warning that does not gate drops).
  const setColumnWip = useCallback(
    async (columnId: string, limit: number | null) => {
      const snapshot = columnsRef.current;
      const name = colName(snapshot, columnId);
      setColumns((prev) => prev.map((c) => (c.id === columnId ? { ...c, wipLimit: limit } : c)));
      try {
        const res = await fetch(`/api/board/columns/${columnId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ wipLimit: limit }),
        });
        if (res.ok) {
          const dto = (await res.json()) as BoardColumnConfigDto;
          setColumns((prev) =>
            prev.map((c) => (c.id === columnId ? { ...c, wipLimit: dto.wipLimit } : c)),
          );
          return;
        }
        setColumns(snapshot);
        toast({
          variant: 'error',
          title: t('wipSaveErrorTitle'),
          description: t('wipSaveErrorDescription', { column: name }),
        });
      } catch {
        setColumns(snapshot);
        toast({
          variant: 'error',
          title: t('wipSaveErrorTitle'),
          description: t('wipSaveErrorDescription', { column: name }),
        });
      }
    },
    [colName, t, toast],
  );

  const handleDragStart = useCallback((e: DragStartEvent) => {
    snapshotRef.current = columnsRef.current;
    setActiveCard(findCard(columnsRef.current, String(e.active.id)));
  }, []);

  const handleDragOver = useCallback(
    (e: DragOverEvent) => {
      const { active, over } = e;
      if (!over) return;
      const cols = columnsRef.current;
      const activeId = String(active.id);
      const overId = String(over.id);

      if (!swimlaned) {
        // FLAT (3.2.4) — relocate within / across columns.
        const fromColId = findCardColumnId(cols, activeId);
        const overColId = columnOfOverId(cols, overId);
        if (!fromColId || !overColId) return;
        const overCol = cols.find((c) => c.id === overColId);
        const overIsColumn = overId === overColId;
        const len = overCol?.cards.length ?? 0;
        if (fromColId === overColId) {
          if (overIsColumn || overId === activeId) return;
          const fromIndex = cardIndex(cols, fromColId, activeId);
          const overIndex = cardIndex(cols, overColId, overId);
          if (fromIndex === -1 || overIndex === -1 || fromIndex === overIndex) return;
          setColumns(relocateCard(cols, activeId, overColId, overIndex));
          return;
        }
        const toIndex = overIsColumn ? len : Math.max(0, cardIndex(cols, overColId, overId));
        setColumns(relocateCard(cols, activeId, overColId, toIndex));
        return;
      }

      // SWIMLANE (3.3.5) — relocate into the target (column × lane) cell.
      const targetCell = cellOfOverId(cols, overId);
      if (!targetCell) return;
      setOverLaneKey(targetCell.laneKey);
      // Hovering a CARD (not the cell body / itself) inserts before it; a cell
      // droppable id resolves to an append.
      const overCardId = parseCellId(overId) !== null || overId === activeId ? null : overId;
      const next = relocateCardToCell(
        cols,
        activeId,
        targetCell.columnId,
        targetCell.laneKey,
        overCardId,
      );
      if (next !== cols) setColumns(next);
    },
    [swimlaned],
  );

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      setActiveCard(null);
      setOverLaneKey(null);
      const snapshot = snapshotRef.current ?? columnsRef.current;
      snapshotRef.current = null;
      const cols = columnsRef.current;
      const activeId = String(active.id);

      if (!over) {
        setColumns(snapshot);
        return;
      }

      if (!swimlaned) {
        // FLAT (3.2.4) — unchanged.
        const targetColId = findCardColumnId(cols, activeId);
        const originColId = findCardColumnId(snapshot, activeId);
        if (!targetColId || !originColId) {
          setColumns(snapshot);
          return;
        }
        const originIndex = cardIndex(snapshot, originColId, activeId);
        const finalIndex = cardIndex(cols, targetColId, activeId);
        if (originColId === targetColId && originIndex === finalIndex) {
          setColumns(snapshot);
          return;
        }
        const optimistic = transferCount(cols, originColId, targetColId);
        setColumns(optimistic);
        const card = findCard(optimistic, activeId);
        if (!card) {
          setColumns(snapshot);
          return;
        }
        const { beforeId, afterId } = neighborsOf(optimistic, targetColId, activeId);
        void runMove({
          workItemId: activeId,
          toColumnId: targetColId,
          beforeId,
          afterId,
          snapshot,
          card,
          fromColName: colName(snapshot, originColId),
          toColName: colName(optimistic, targetColId),
        });
        return;
      }

      // SWIMLANE (3.3.5).
      const move = resolveCellMove(snapshot, cols, activeId);
      if (!move) {
        setColumns(snapshot);
        return;
      }
      const { columnChanged, laneChanged } = move;
      const rankChanged =
        !columnChanged && !laneChanged && move.originIndexInCell !== move.finalIndexInCell;
      if (!columnChanged && !laneChanged && !rankChanged) {
        // Dropped back where it started — restore the canonical snapshot.
        setColumns(snapshot);
        return;
      }

      // Optimistic count transfer for a column change, then read the settled card.
      const optimistic = columnChanged
        ? transferCount(cols, move.originColId, move.targetColId)
        : cols;
      if (optimistic !== cols) setColumns(optimistic);
      const card = findCard(optimistic, activeId);
      if (!card) {
        setColumns(snapshot);
        return;
      }

      if (columnChanged || rankChanged) {
        void runTransition({
          workItemId: activeId,
          originColId: move.originColId,
          targetColId: move.targetColId,
          beforeId: move.beforeId,
          afterId: move.afterId,
          card,
          fromColName: colName(snapshot, move.originColId),
          toColName: colName(optimistic, move.targetColId),
        });
      }
      if (laneChanged) {
        void runReassign({
          workItemId: activeId,
          originLaneKey: move.originLaneKey,
          targetLaneKey: move.targetLaneKey,
          card,
        });
      }
    },
    [swimlaned, colName, runMove, runTransition, runReassign],
  );

  const handleDragCancel = useCallback(() => {
    setActiveCard(null);
    setOverLaneKey(null);
    if (snapshotRef.current) {
      setColumns(snapshotRef.current);
      snapshotRef.current = null;
    }
  }, []);

  // aria-live narration. In swimlane mode the DROP announcement distinguishes a
  // reassign (lane only) / transition (column only) / diagonal (both) per the
  // 3.3.1 copy; pick-up + move reuse the flat copy.
  const announcements = useMemo<Announcements>(() => {
    const keyOf = (id: string) => findCard(columnsRef.current, id)?.identifier ?? id;
    const at = (overId: string) => {
      const cols = columnsRef.current;
      const colId = swimlaned ? cellOfOverId(cols, overId)?.columnId : columnOfOverId(cols, overId);
      const col = cols.find((c) => c.id === colId);
      if (!col) return null;
      const idx = overId === colId ? col.cards.length : cardIndex(cols, col.id, overId);
      return {
        col: col.name,
        index: (idx < 0 ? col.cards.length : idx) + 1,
        count: col.cards.length,
      };
    };
    return {
      onDragStart({ active }) {
        const info = at(String(active.id));
        return info
          ? t('announcementPickedUp', { key: keyOf(String(active.id)), ...info })
          : undefined;
      },
      onDragOver({ active, over }) {
        if (!over) return undefined;
        const info = at(String(over.id));
        return info
          ? t('announcementMoved', { key: keyOf(String(active.id)), ...info })
          : undefined;
      },
      onDragEnd({ active, over }) {
        if (!over) return undefined;
        const key = keyOf(String(active.id));
        const cols = columnsRef.current;
        if (!swimlaned) {
          const colId = columnOfOverId(cols, String(over.id));
          return t('announcementDropped', { key, col: colName(cols, colId) });
        }
        const move = snapshotRef.current
          ? resolveCellMove(snapshotRef.current, cols, String(active.id))
          : null;
        if (!move) return undefined;
        const col = colName(cols, move.targetColId);
        const group = laneLabel(move.targetLaneKey);
        if (move.columnChanged && move.laneChanged)
          return t('announcementDiagonal', { key, col, group });
        if (move.laneChanged) return t('announcementReassigned', { key, group });
        return t('announcementDropped', { key, col });
      },
      onDragCancel({ active }) {
        const snap = snapshotRef.current ?? columnsRef.current;
        const colId = findCardColumnId(snap, String(active.id));
        return t('announcementCancelled', {
          key: keyOf(String(active.id)),
          col: colName(snap, colId),
        });
      },
    };
  }, [swimlaned, colName, laneLabel, t]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t('dndInstructions') },
      }}
    >
      {swimlaned ? (
        <SwimlaneBoard
          boardId={board.boardId}
          columns={columns}
          swimlanes={board.swimlanes}
          assigneeNameById={assigneeNameById}
          onOpenQuickView={openPeek}
          onSetWipLimit={setColumnWip}
          activeCardId={activeCard?.id ?? null}
          overLaneKey={overLaneKey}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          {/* The horizontally-scrolling column row. Scroll-snap (proximity, so it
              never fights a deliberate scroll) makes narrow viewports read as a
              single-column pager (3.2.6, panel 7); each column is wrapped with
              `data-board-column` so the pager hook can locate it. The wrapper is
              the snap target — BoardColumn keeps its own droppable ref + width. */}
          <div
            ref={scrollRef}
            role="group"
            aria-label={t('boardLabel')}
            tabIndex={0}
            className="flex snap-x snap-proximity gap-4 overflow-x-auto pb-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            data-testid="board"
          >
            {columns.map((column) => (
              <div key={column.id} data-board-column className="flex shrink-0 snap-start">
                <BoardColumn
                  column={column}
                  assigneeNameById={assigneeNameById}
                  onOpenQuickView={openPeek}
                  activeCardId={activeCard?.id ?? null}
                  onSetWipLimit={setColumnWip}
                />
              </div>
            ))}
          </div>
          <BoardColumnPager columns={columns} activeIndex={activeColumn} />
        </div>
      )}
      <DragOverlay>
        {activeCard ? (
          <BoardCardOverlay
            card={activeCard}
            assigneeName={
              activeCard.assigneeId ? (assigneeNameById.get(activeCard.assigneeId) ?? null) : null
            }
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
