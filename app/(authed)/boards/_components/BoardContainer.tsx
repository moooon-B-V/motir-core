'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import {
  type BoardCardDto,
  type BoardColumnDto,
  type BoardProjectionDto,
  type BoardSwimlaneGroupByDto,
} from '@/lib/dto/boards';
import type { MoveCardResultDto, PagedColumnCardsDto } from '@/lib/dto/boards';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { usePeekOpen } from '../../issues/_components/IssueQuickView';
import { updateIssueAction } from '../../issues/[key]/edit/actions';
import { BoardCardOverlay } from './BoardCard';
import { BoardColumn } from './BoardColumn';
import { BoardSkeleton } from './BoardSkeleton';
import { SwimlaneBoard } from './SwimlaneBoard';
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
import { appendColumnPage } from './boardPaging';

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
// board fetch, the move POST, the group-by PATCH, and the existing 2.5
// field-update action the cross-lane drag reuses — no new route (CLAUDE.md).

type BoardStatus = 'loading' | 'ready' | 'error' | 'no-board';

export function BoardContainer({ members = [] }: { members?: WorkspaceMemberDTO[] }) {
  const t = useTranslations('boards');
  const { toast } = useToast();
  const [board, setBoard] = useState<BoardProjectionDto | null>(null);
  const [status, setStatus] = useState<BoardStatus>('loading');
  // 'relaying' = a group-by change is fetching the new projection; the toolbar
  // stays mounted (so the control is still visible) while the grid shows the
  // skeleton — the re-lay loading transition, not a flash of the old layout.
  const [relaying, setRelaying] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    fetch('/api/board', { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as BoardProjectionDto;
          if (!active) return;
          setBoard(data);
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
  }, [reloadKey]);

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

  return (
    <div className="flex flex-col gap-3">
      <GroupByControl value={board.swimlaneGroupBy} onChange={changeGroupBy} disabled={relaying} />
      {relaying ? (
        <BoardSkeleton />
      ) : (
        // Key by board + group-by so a group-by change remounts with a fresh
        // columns/lanes state rather than reconciling across layouts.
        <BoardDnd
          key={`${board.boardId}:${board.swimlaneGroupBy}`}
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

  const columnsRef = useRef(columns);
  useLayoutEffect(() => {
    columnsRef.current = columns;
  }, [columns]);
  const snapshotRef = useRef<BoardColumnDto[] | null>(null);

  const [paging, setPaging] = useState<Record<string, 'loading' | 'error'>>({});
  const inFlightRef = useRef<Set<string>>(new Set());

  const loadMore = useCallback(
    (columnId: string) => {
      const col = columnsRef.current.find((c) => c.id === columnId);
      if (!col || col.cursor === null || inFlightRef.current.has(columnId)) return;
      inFlightRef.current.add(columnId);
      const cursor = col.cursor;
      setPaging((prev) => ({ ...prev, [columnId]: 'loading' }));
      const url =
        `/api/board/columns/${encodeURIComponent(columnId)}/cards` +
        `?boardId=${encodeURIComponent(board.boardId)}&cursor=${encodeURIComponent(cursor)}`;
      fetch(url, { headers: { accept: 'application/json' } })
        .then(async (res) => {
          if (!res.ok) throw new Error(`load-more ${res.status}`);
          const page = (await res.json()) as PagedColumnCardsDto;
          setColumns((prev) => appendColumnPage(prev, columnId, page));
          setPaging((prev) => {
            const next = { ...prev };
            delete next[columnId];
            return next;
          });
        })
        .catch(() => {
          setPaging((prev) => ({ ...prev, [columnId]: 'error' }));
        })
        .finally(() => {
          inFlightRef.current.delete(columnId);
        });
    },
    [board.boardId],
  );

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
          onLoadMore={loadMore}
          paging={paging}
          activeCardId={activeCard?.id ?? null}
          overLaneKey={overLaneKey}
        />
      ) : (
        <div
          role="group"
          aria-label={t('boardLabel')}
          tabIndex={0}
          className="flex gap-4 overflow-x-auto pb-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          data-testid="board"
        >
          {columns.map((column) => (
            <BoardColumn
              key={column.id}
              column={column}
              assigneeNameById={assigneeNameById}
              onOpenQuickView={openPeek}
              onLoadMore={loadMore}
              loadingMore={paging[column.id] === 'loading'}
              loadError={paging[column.id] === 'error'}
              activeCardId={activeCard?.id ?? null}
            />
          ))}
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
