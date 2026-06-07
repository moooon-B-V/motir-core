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
import { ErrorState } from '@/components/ui/ErrorState';
import { useToast } from '@/components/ui/Toast';
import type { BoardCardDto, BoardColumnDto, BoardProjectionDto } from '@/lib/dto/boards';
import type { MoveCardResultDto } from '@/lib/dto/boards';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { useCreateIssue } from '../../_components/CreateIssueProvider';
import { usePeekOpen } from '../../issues/_components/IssueQuickView';
import { BoardCardOverlay } from './BoardCard';
import { BoardColumn } from './BoardColumn';
import { BoardColumnPager, useActiveColumnIndex } from './BoardColumnPager';
import { BoardEmptyState } from './BoardEmptyState';
import { BoardSkeleton } from './BoardSkeleton';
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

// The board client container (Subtask 3.2.2 · drag-drop wired in 3.2.4) — the
// data layer + state machine the column/card/DnD subtasks build on. It is a PURE
// CONSUMER of the Story-3.1.6 board API: it fetches `GET /api/board` (the active
// project's default board) on mount and renders the board-level states from
// `design/boards/board.mock.html` (panel 6): a loading skeleton while the
// projection streams, an ErrorState (with retry) on a failed fetch, and the
// defensive no-board case. There is NO data access here beyond the board fetch +
// the move POST — no Prisma, no new route (CLAUDE.md).
//
// State shape: the projection lives in component state as `board`, with its
// `columns[].cards` arrays held so the later subtasks can mutate ONE column's
// card list in place (3.2.4 optimistic moves, 3.2.5 appended pages) without
// refetching the whole board.
//
// Completeness (Subtask 3.2.6): an all-empty board renders the board EMPTY
// state (a "New work item" CTA, not six blank columns); `unmappedStatuses`
// renders the unmapped-statuses TRAY above the board; and the column row is a
// scroll-snap single-column pager on narrow viewports — see `BoardDnd`.
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
  const [board, setBoard] = useState<BoardProjectionDto | null>(null);
  // Starts 'loading' — the mount effect fires the fetch immediately (flipping it
  // synchronously inside the effect is the cascading-render anti-pattern the lint
  // forbids, so the initial value carries the loading state).
  const [status, setStatus] = useState<BoardStatus>('loading');
  // Bumped by `retry` to re-run the fetch effect.
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
    fetch('/api/board', { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as BoardProjectionDto;
          if (!active) return;
          setBoard(data);
          setBoardVersion((v) => v + 1);
          setStatus('ready');
          return;
        }
        // A 404 BOARD_NOT_FOUND is the defensive no-board case (3.1 auto-seeds a
        // board per project, so this is rare); any other non-OK is a generic
        // load failure. Read the typed `code` to distinguish; a non-JSON body
        // falls through to the generic error.
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
  }, [reloadKey, issuesChangedAt, activeProjectId]);

  // Reset to the loading shell (an event-handler setState — allowed) and bump the
  // key so the fetch effect re-runs.
  const retry = useCallback(() => {
    setStatus('loading');
    setReloadKey((k) => k + 1);
  }, []);

  // userId → display name, so a card resolves its `assigneeId` to an avatar
  // (name || email, the same fallback the issue-list inline-edit cell uses).
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
  //     items"; rung-2 guard).
  const hasUnmapped = board.unmappedStatuses.length > 0;
  const isEmpty = !hasUnmapped && board.columns.every((c) => c.totalCount === 0);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {hasUnmapped ? <UnmappedStatusesTray statuses={board.unmappedStatuses} /> : null}
      {isEmpty ? (
        <BoardEmptyState />
      ) : (
        // Key by `boardVersion` so each refetch re-seeds the interactive board
        // (its column state is mount-seeded); a create then shows the new card.
        <BoardDnd key={boardVersion} board={board} assigneeNameById={assigneeNameById} />
      )}
    </div>
  );
}

// The interactive board (Subtask 3.2.4) — the horizontally-scrolling row of
// columns (design panel 0) wrapped in a dnd-kit `DndContext`. It owns the
// mutable `columns` state (seeded from the projection) so a drag can move a card
// optimistically, then reconcile it against `POST /api/board/move`:
//   - cross-column drop  → a workflow TRANSITION (server resolves the target
//     status + validates via `canTransition`); the UI defers legality to it.
//   - in-column drop     → a rank change (`work_item.position`).
// On 200 it reconciles to the returned card (+ moves one unit of `totalCount`);
// on 409 (illegal transition) / 422 (unmapped target) / any other error it
// SNAPS the card back to the pre-drag snapshot and toasts — the card never rests
// in a rejected position (the contract carried from Story 3.1).
//
// Pointer + keyboard sensors both drive it (the stub mandates accessible keyboard
// DnD): the pointer sensor's 8px activation distance keeps a plain click opening
// the quick view, while the keyboard sensor's sole start key is Space (Enter
// stays the quick-view activator, per 3.2.2). Live `aria-live` announcements
// (copy from `design/boards/design-notes.md`) narrate pick-up / move / drop /
// cancel; the rejection is announced via the toast (role=status).
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

  const [columns, setColumns] = useState<BoardColumnDto[]>(board.columns);
  const [activeCard, setActiveCard] = useState<BoardCardDto | null>(null);

  // The horizontal scroll region (the column row) + which column is centred in
  // it — drives the mobile pager (Subtask 3.2.6, design panel 7). On a narrow
  // viewport the board reads as a single-column scroll; the pager shows
  // "{name} · {i} of {n}".
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
    // 8px before a press becomes a drag — below that it's a click (→ quick view).
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // Space picks up / drops, Escape cancels; Enter is intentionally NOT a start
    // key so it still activates the card's quick-view click (3.2.2 contract).
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );

  const colName = useCallback(
    (cols: BoardColumnDto[], colId: string | null) => cols.find((c) => c.id === colId)?.name ?? '',
    [],
  );

  // Snap the optimistic state back to the pre-drag snapshot + explain why. Shared
  // by the 409 / 422 / network / generic-error branches.
  const snapBack = useCallback(
    (snapshot: BoardColumnDto[], description: string) => {
      setColumns(snapshot);
      toast({ variant: 'error', title: t('moveRejectedTitle'), description });
    },
    [t, toast],
  );

  // Fire the move and reconcile. Apply already happened optimistically; here we
  // confirm (200) or snap back (rejection). Manual-mode: no CI blocking, fire
  // and forget the request.
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

  const handleDragStart = useCallback((e: DragStartEvent) => {
    snapshotRef.current = columnsRef.current;
    setActiveCard(findCard(columnsRef.current, String(e.active.id)));
  }, []);

  // Live cross-column AND in-column relocation while dragging — the standard
  // dnd-kit multi-container pattern, so the dashed ghost tracks the insertion
  // slot and the keyboard drag visibly crosses columns. Counts are not touched
  // here (they move once, at drop) to avoid churn from repeated over-events.
  const handleDragOver = useCallback((e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const cols = columnsRef.current;
    const activeId = String(active.id);
    const overId = String(over.id);
    const fromColId = findCardColumnId(cols, activeId);
    const overColId = columnOfOverId(cols, overId);
    if (!fromColId || !overColId) return;

    const overCol = cols.find((c) => c.id === overColId);
    const overIsColumn = overId === overColId;
    const len = overCol?.cards.length ?? 0;

    if (fromColId === overColId) {
      // In-column reorder: slot the card at the over card's index.
      if (overIsColumn || overId === activeId) return;
      const fromIndex = cardIndex(cols, fromColId, activeId);
      const overIndex = cardIndex(cols, overColId, overId);
      if (fromIndex === -1 || overIndex === -1 || fromIndex === overIndex) return;
      setColumns(relocateCard(cols, activeId, overColId, overIndex));
      return;
    }

    // Cross-column: insert at the over card's index, or append for a column-body
    // / empty-column drop.
    const toIndex = overIsColumn ? len : Math.max(0, cardIndex(cols, overColId, overId));
    setColumns(relocateCard(cols, activeId, overColId, toIndex));
  }, []);

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      setActiveCard(null);
      const snapshot = snapshotRef.current ?? columnsRef.current;
      snapshotRef.current = null;

      const cols = columnsRef.current; // already reflects the live over-moves
      const activeId = String(active.id);

      if (!over) {
        setColumns(snapshot);
        return;
      }

      const targetColId = findCardColumnId(cols, activeId);
      const originColId = findCardColumnId(snapshot, activeId);
      if (!targetColId || !originColId) {
        setColumns(snapshot);
        return;
      }

      // No real change (dropped back where it started) → restore the canonical
      // snapshot and skip the server round-trip.
      const originIndex = cardIndex(snapshot, originColId, activeId);
      const finalIndex = cardIndex(cols, targetColId, activeId);
      if (originColId === targetColId && originIndex === finalIndex) {
        setColumns(snapshot);
        return;
      }

      // Transfer one unit of count (cross-column only), then read the rank
      // neighbours from the settled position for the move request.
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
    },
    [colName, runMove],
  );

  const handleDragCancel = useCallback(() => {
    setActiveCard(null);
    if (snapshotRef.current) {
      setColumns(snapshotRef.current);
      snapshotRef.current = null;
    }
  }, []);

  // aria-live narration (copy from design/boards/design-notes.md). Position is
  // reported within the loaded card set (i of n) — the conventional sortable
  // announcement granularity.
  const announcements = useMemo<Announcements>(() => {
    const at = (overId: string) => {
      const cols = columnsRef.current;
      const colId = columnOfOverId(cols, overId);
      const col = cols.find((c) => c.id === colId);
      if (!col) return null;
      const idx = overId === colId ? col.cards.length : cardIndex(cols, col.id, overId);
      return {
        col: col.name,
        index: (idx < 0 ? col.cards.length : idx) + 1,
        count: col.cards.length,
      };
    };
    const keyOf = (id: string) => findCard(columnsRef.current, id)?.identifier ?? id;
    return {
      onDragStart({ active }) {
        const info = at(String(active.id));
        if (!info) return undefined;
        return t('announcementPickedUp', { key: keyOf(String(active.id)), ...info });
      },
      onDragOver({ active, over }) {
        if (!over) return undefined;
        const info = at(String(over.id));
        if (!info) return undefined;
        return t('announcementMoved', { key: keyOf(String(active.id)), ...info });
      },
      onDragEnd({ active, over }) {
        if (!over) return undefined;
        const cols = columnsRef.current;
        const colId = columnOfOverId(cols, String(over.id));
        return t('announcementDropped', {
          key: keyOf(String(active.id)),
          col: colName(cols, colId),
        });
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
  }, [colName, t]);

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
              />
            </div>
          ))}
        </div>
        <BoardColumnPager columns={columns} activeIndex={activeColumn} />
      </div>
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
