'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';
import type { BoardColumnDto, BoardProjectionDto } from '@/lib/dto/boards';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { usePeekOpen } from '../../issues/_components/IssueQuickView';
import { BoardColumn } from './BoardColumn';
import { BoardSkeleton } from './BoardSkeleton';

// The board client container (Subtask 3.2.2) — the data layer + state machine
// the column/card/DnD subtasks build on. It is a PURE CONSUMER of the Story-3.1.6
// board API: it fetches `GET /api/board` (the active project's default board) on
// mount and renders the board-level states from `design/boards/board.mock.html`
// (panel 6): a loading skeleton while the projection streams, an ErrorState (with
// retry) on a failed fetch, and the defensive no-board case. There is NO data
// access here beyond the one fetch — no Prisma, no new route (CLAUDE.md).
//
// State shape: the projection lives in component state as `board`, with its
// `columns[].cards` arrays held so the later subtasks can mutate ONE column's
// card list in place (3.2.4 optimistic moves, 3.2.5 appended pages) without
// refetching the whole board; `unmappedStatuses` is carried for the 3.2.6 tray.
//
// SCOPE: 3.2.2 shipped the route, the fetch, the state container, and the
// loading/error/no-board shells. Subtask 3.2.3 swaps the column scaffold for the
// real `BoardColumn`/`BoardCard` (reusing the issue primitives) — the card click
// → IssueQuickView seam stays. Still ahead: drag-drop (3.2.4), lazy load-more +
// virtualization (3.2.5), and the project-empty + unmapped tray (3.2.6).
//
// `members` (the workspace member directory the board page already resolves) lets
// the cards map each `BoardCardDto.assigneeId` to a display name for the avatar —
// the projection card carries only the id (Story 3.1.4).

type BoardStatus = 'loading' | 'ready' | 'error' | 'no-board';

export function BoardContainer({ members = [] }: { members?: WorkspaceMemberDTO[] }) {
  const t = useTranslations('boards');
  const [board, setBoard] = useState<BoardProjectionDto | null>(null);
  // Starts 'loading' — the mount effect fires the fetch immediately (flipping it
  // synchronously inside the effect is the cascading-render anti-pattern the lint
  // forbids, so the initial value carries the loading state).
  const [status, setStatus] = useState<BoardStatus>('loading');
  // Bumped by `retry` to re-run the fetch effect.
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
  }, [reloadKey]);

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

  return <BoardColumns columns={board.columns} assigneeNameById={assigneeNameById} />;
}

// The horizontally-scrolling row of columns (design panel 0: `.board`,
// overflow-x auto, fixed-width 288px columns). 3.2.4 wires the dnd-kit
// DndContext around this; 3.2.6 adds the board-level empty state + the
// unmapped-statuses tray.
//
// The row is the horizontal scroll region — it carries `tabIndex={0}` + an
// accessible name so it's keyboard-operable even when no column has cards (the
// axe `scrollable-region-focusable` rule). Per-column vertical scroll +
// virtualization land in 3.2.5; the columns cap their own height + scroll their
// card body, and the page scrolls under the shell.
function BoardColumns({
  columns,
  assigneeNameById,
}: {
  columns: BoardColumnDto[];
  assigneeNameById: Map<string, string>;
}) {
  const t = useTranslations('boards');
  const openPeek = usePeekOpen();
  return (
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
        />
      ))}
    </div>
  );
}
