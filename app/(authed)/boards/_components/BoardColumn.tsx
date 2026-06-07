'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Spinner } from '@/components/ui/Spinner';
import { useRowWindow } from '@/components/ui/useRowWindow';
import type { BoardColumnDto } from '@/lib/dto/boards';
import { BoardCard } from './BoardCard';
import { ColumnActionsMenu } from './ColumnActionsMenu';
import { ColumnWipBadge } from './ColumnWipBadge';
import { columnHasMore } from './boardPaging';

// BoardColumn (Subtask 3.2.3 · drop 3.2.4 · scale 3.2.5) — one board column per
// `design/boards/board.mock.html` (`.col`): a header over a scrollable card
// stack, with a designed empty-column state. The header carries (in order):
//   - the column `name` + the per-column total count badge (the projection's
//     `totalCount` — the denominator, independent of how many cards are loaded)
//   - the WIP-limit chip (`ColumnWipBadge`, 3.3.6): `n/limit` with the SOFT
//     over-limit warning when `n > limit`
//   - the column-actions `[⋯]` menu (`ColumnActionsMenu`, 3.3.6) whose "Set WIP
//     limit" editor sets/clears the limit via `onSetWipLimit` (config only —
//     SOFT, so it never gates the droppable; the 3.2.4 move contract is intact)
//
// DROP TARGET (3.2.4): the whole column is a dnd-kit droppable and the cards are a
// vertical `SortableContext`; while a card is dragged over, the accent ring +
// lavender tint mark it (paired cues, finding #35).
//
// SCALE (3.2.5, finding #57): the card stack VIRTUALIZES — only the cards in (or
// near) the column's own scroll viewport mount, via `useRowWindow` (the hand-
// rolled 2.5.15 windowing generalized to variable-height cards; no second lib).
// The `SortableContext` `items` list stays the FULL ordered set so dnd-kit knows
// every card's rank even when only a window is mounted, and the actively-dragged
// card (+ its neighbours) is force-mounted so a drag never detaches mid-flight.
// A `.col-foot` "Load more" footer pages in the next bounded slice via
// `onLoadMore` (the parent calls the Story-3.1.6 cursor route + appends in place);
// an IntersectionObserver sentinel auto-loads on scroll-to-bottom. The board never
// loads every card. Colour strictly `--el-*`, shape via element tokens.

// Estimated card height (px) used before a card's real height is measured; the
// title clamps to 1–2 lines so true heights vary — `useRowWindow` measures each.
const CARD_ESTIMATE_PX = 116;
const CARD_GAP_PX = 8; // the `.col-body` inter-card gap from the design mock
// Cards on either side of the dragged card kept mounted alongside the window so a
// drag out of (or within) a virtualized column never loses its node.
const DRAG_KEEP = 2;

export function BoardColumn({
  column,
  assigneeNameById,
  onOpenQuickView,
  onLoadMore,
  loadingMore,
  loadError,
  activeCardId,
  onSetWipLimit,
}: {
  column: BoardColumnDto;
  assigneeNameById: Map<string, string>;
  onOpenQuickView: (identifier: string) => void;
  onLoadMore: (columnId: string) => void;
  loadingMore: boolean;
  loadError: boolean;
  activeCardId: string | null;
  onSetWipLimit: (columnId: string, limit: number | null) => void;
}) {
  const t = useTranslations('boards');
  // The whole column is the droppable, so a drop anywhere in it (incl. the empty
  // body) resolves to this column; the card SortableContext handles the slot.
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  const cards = column.cards;
  const empty = cards.length === 0;
  const hasMore = columnHasMore(column);
  const dragActive = activeCardId !== null;

  // The column body is the scroll viewport the card stack windows against.
  const bodyRef = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback(() => bodyRef.current, []);
  const { containerRef, range, totalSize, getOffset, measureElement, windowing } = useRowWindow({
    count: cards.length,
    estimateRowHeight: CARD_ESTIMATE_PX,
    gap: CARD_GAP_PX,
    getScrollElement,
  });

  // Auto-load on scroll: a sentinel at the bottom of the (full-height) scroll area
  // pages the next slice when it enters view. The footer button is the explicit
  // fallback; the parent's `loadMore` guards against a double-fire. Suspended
  // while a drag is active so content never shifts mid-drag.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const columnId = column.id;
  useEffect(() => {
    if (!hasMore || dragActive) return;
    const root = bodyRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore(columnId);
      },
      { root, rootMargin: '200px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore, dragActive, columnId, onLoadMore]);

  // The card indices to mount: the window, plus the dragged card and its
  // neighbours (so a drag never detaches). Whole list when not windowing.
  const indices: number[] = [];
  if (windowing) {
    const set = new Set<number>();
    for (let i = range.start; i < range.end; i++) set.add(i);
    if (activeCardId) {
      const ai = cards.findIndex((c) => c.id === activeCardId);
      if (ai >= 0) {
        for (let j = ai - DRAG_KEEP; j <= ai + DRAG_KEEP; j++) {
          if (j >= 0 && j < cards.length) set.add(j);
        }
      }
    }
    indices.push(...[...set].sort((a, b) => a - b));
  } else {
    for (let i = 0; i < cards.length; i++) indices.push(i);
  }

  return (
    // The column caps its height to the available screen height (viewport minus
    // the top nav + page header + gutters ≈ 12rem); the card body scrolls
    // internally, the footer stays pinned at the bottom. While a card is dragged
    // over, the accent ring + lavender tint mark it as the drop target.
    <section
      ref={setNodeRef}
      aria-label={t('columnLabel', { name: column.name, count: column.totalCount })}
      data-testid={`board-column-${column.id}`}
      data-over={isOver ? 'true' : undefined}
      className={`flex max-h-[calc(100dvh-12rem)] w-72 shrink-0 flex-col rounded-(--radius-card) border bg-(--el-surface) transition-colors ${
        isOver
          ? 'border-(--el-accent) bg-(--el-tint-lavender) outline outline-2 outline-(--el-accent)'
          : 'border-(--el-border)'
      }`}
    >
      <header className="flex items-center gap-2 border-b border-(--el-border) px-3 py-2.5">
        <h2 className="text-[13px] font-semibold text-(--el-text-strong)">{column.name}</h2>
        <span
          className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) text-xs font-semibold text-(--el-text-secondary)"
          data-testid={`board-count-${column.id}`}
        >
          {column.totalCount}
        </span>
        <span className="flex-1" />
        {/* WIP-limit chip — `n/limit` + the SOFT over-limit warning (3.3.6). */}
        <ColumnWipBadge
          columnId={column.id}
          totalCount={column.totalCount}
          wipLimit={column.wipLimit}
        />
        {/* Column actions — the `[⋯]` menu hosting the WIP-limit editor (3.3.6). */}
        <ColumnActionsMenu
          columnId={column.id}
          wipLimit={column.wipLimit}
          onSetWipLimit={onSetWipLimit}
        />
      </header>

      {empty ? (
        <div className="p-2.5">
          <p className="my-1 rounded-(--radius-card) border border-dashed border-(--el-border) px-2.5 py-4 text-center text-xs text-(--el-text-muted)">
            {t('emptyColumn')}
          </p>
        </div>
      ) : (
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div
              ref={containerRef}
              className={windowing ? 'relative' : 'flex flex-col gap-2'}
              style={windowing ? { height: totalSize } : undefined}
            >
              {indices.map((index) => {
                const card = cards[index]!;
                return (
                  <div
                    key={card.id}
                    ref={measureElement(index)}
                    style={
                      windowing
                        ? { position: 'absolute', top: getOffset(index), left: 0, right: 0 }
                        : undefined
                    }
                  >
                    <BoardCard
                      card={card}
                      assigneeName={
                        card.assigneeId ? (assigneeNameById.get(card.assigneeId) ?? null) : null
                      }
                      onOpenQuickView={onOpenQuickView}
                    />
                  </div>
                );
              })}
            </div>
            {/* Scroll-to-load sentinel (enhancement; the footer button is the
                explicit affordance). Sits just past the full-height card area. */}
            {hasMore ? <div ref={sentinelRef} aria-hidden className="h-px w-full" /> : null}
          </SortableContext>
        </div>
      )}

      {/* `.col-foot` — the Load more button + the virtualization note (finding
          #57). Shown when there are more pages OR the stack is virtualized. */}
      {!empty && (hasMore || windowing) ? (
        <div className="shrink-0 px-2.5 pt-1 pb-2.5">
          {loadError ? (
            <p className="pb-1.5 text-center text-xs text-(--el-danger)">{t('loadMoreError')}</p>
          ) : null}
          {hasMore ? (
            <button
              type="button"
              onClick={() => onLoadMore(column.id)}
              disabled={loadingMore}
              data-testid={`board-load-more-${column.id}`}
              className="flex h-(--height-control) w-full items-center justify-center gap-1.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-page-bg) text-[13px] font-medium text-(--el-text-secondary) hover:border-(--el-border-strong) disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loadingMore ? (
                <>
                  <Spinner size="sm" aria-label={t('loadingMore')} />
                  {t('loadingMore')}
                </>
              ) : loadError ? (
                t('loadMoreRetry')
              ) : (
                t('loadMore')
              )}
            </button>
          ) : null}
          {windowing ? (
            <p
              className="pt-1.5 text-center font-mono text-[11px] text-(--el-text-faint)"
              data-testid={`board-virt-note-${column.id}`}
            >
              {t('virtNote', { loaded: cards.length })}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
