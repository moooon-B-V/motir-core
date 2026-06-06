'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ui/ErrorState';
import type { BoardCardDto, BoardColumnDto, BoardProjectionDto } from '@/lib/dto/boards';
import { usePeekOpen } from '../../issues/_components/IssueQuickView';
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
// SCOPE: this subtask ships the route, the fetch, the state container, the
// loading/error/no-board shells, and a minimal COLUMN SCAFFOLD (header + count +
// clickable card seam → IssueQuickView). The full `BoardColumn`/`BoardCard`
// (reusing the issue primitives), drag-drop (3.2.4), lazy load-more +
// virtualization (3.2.5), and the project-empty + unmapped tray (3.2.6) replace
// / extend the seams below.

type BoardStatus = 'loading' | 'ready' | 'error' | 'no-board';

export function BoardContainer() {
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

  if (status === 'loading') return <BoardSkeleton />;

  if (status === 'no-board') {
    return (
      <ErrorState title={t('noBoardTitle')} description={t('noBoardDescription')} retry={retry} />
    );
  }

  if (status === 'error' || !board) {
    return <ErrorState title={t('errorTitle')} description={t('errorDescription')} retry={retry} />;
  }

  return <BoardColumns columns={board.columns} />;
}

// The horizontally-scrolling row of columns (design panel 0: `.board`,
// overflow-x auto, fixed-width 288px columns). 3.2.3 swaps the scaffold below for
// the real `BoardColumn`/`BoardCard`; 3.2.4 wires the dnd-kit DndContext around
// this; 3.2.6 adds the board-level empty state + the unmapped-statuses tray.
function BoardColumns({ columns }: { columns: BoardColumnDto[] }) {
  const openPeek = usePeekOpen();
  return (
    <div className="flex flex-1 gap-4 overflow-x-auto pb-2" data-testid="board">
      {columns.map((column) => (
        <BoardColumnScaffold key={column.id} column={column} onOpenQuickView={openPeek} />
      ))}
    </div>
  );
}

// SEAM for Subtask 3.2.3 (`BoardColumn`): a column shell with the header (name +
// per-column total count) over a scrollable card stack. 3.2.3 adds the WIP
// placeholder slot + the designed empty-column state; 3.2.5 fills the load-more
// footer; 3.2.4 makes the body a droppable.
function BoardColumnScaffold({
  column,
  onOpenQuickView,
}: {
  column: BoardColumnDto;
  onOpenQuickView: (identifier: string) => void;
}) {
  const t = useTranslations('boards');
  return (
    <section
      aria-label={t('columnLabel', { name: column.name, count: column.totalCount })}
      className="flex w-72 shrink-0 flex-col rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft)"
    >
      <header className="flex items-center gap-2 border-b border-(--el-border) px-3 py-2">
        <h2 className="text-[13px] font-semibold text-(--el-text-strong)">{column.name}</h2>
        <span
          className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) text-xs font-semibold text-(--el-text-secondary)"
          data-testid={`board-count-${column.id}`}
        >
          {column.totalCount}
        </span>
      </header>
      <div className="flex flex-col gap-2 overflow-y-auto p-2">
        {column.cards.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-(--el-text-muted)">{t('emptyColumn')}</p>
        ) : (
          column.cards.map((card) => (
            <BoardCardSeam key={card.id} card={card} onOpenQuickView={onOpenQuickView} />
          ))
        )}
      </div>
    </section>
  );
}

// SEAM for Subtask 3.2.3 (`BoardCard`): a minimal, clickable card. Clicking opens
// the EXISTING `IssueQuickView` peek (Story 2.5) — the same surface the issue
// list uses — by pushing `?peek=<identifier>` via the shared `usePeekOpen` hook
// (NOT a new detail surface, NOT a full-page navigation). 3.2.3 replaces the body
// with the full card anatomy (IssueTypeIcon, priority Pill, assignee avatar,
// ReadinessBadge, points chip) composed from the issue-list primitives.
function BoardCardSeam({
  card,
  onOpenQuickView,
}: {
  card: BoardCardDto;
  onOpenQuickView: (identifier: string) => void;
}) {
  const t = useTranslations('boards');
  return (
    <button
      type="button"
      onClick={() => onOpenQuickView(card.identifier)}
      aria-label={t('openIssueAria', { key: card.identifier, title: card.title })}
      data-testid={`board-card-${card.identifier}`}
      className="flex flex-col gap-1 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-(--spacing-card-padding) text-left shadow-(--shadow-subtle) transition-colors hover:border-(--el-border-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <span className="font-mono text-xs text-(--el-text-muted)">{card.identifier}</span>
      <span className="line-clamp-2 text-sm text-(--el-text)">{card.title}</span>
    </button>
  );
}
