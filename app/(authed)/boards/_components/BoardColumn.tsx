'use client';

import { useTranslations } from 'next-intl';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { MoreHorizontal } from 'lucide-react';
import type { BoardColumnDto } from '@/lib/dto/boards';
import { BoardCard } from './BoardCard';

// BoardColumn (Subtask 3.2.3 · drop wired in 3.2.4) — one board column per
// `design/boards/board.mock.html` (`.col`): a header over a scrollable card
// stack, with a designed empty-column state. The header carries (in order):
//   - the column `name` + the per-column total count badge (the projection's
//     `totalCount` — the denominator, independent of how many cards are loaded)
//   - an optional WIP-limit placeholder slot drawn as a `count / limit` display
//     ONLY — Story 3.3 enforces WIP + over-limit warnings; this is not enforced
//   - a disabled column-actions seam (mirrors the page-level Filter seam from
//     3.2.2 — the design shows the affordance; board/column admin is not v1)
//
// DROP TARGET (3.2.4): the card-stack body is a dnd-kit droppable (so an empty
// column and the gaps between cards accept a drop), and the cards inside are a
// vertical `SortableContext`. While a card is dragged over this column the
// section shows the design's redundant cues (finding #35, not colour-alone): an
// accent RING (outline shape) + a lavender TINT (colour) — paired, plus the
// dragged card's dashed ghost marks the insertion slot. Colour strictly
// `--el-*`, shape via element tokens. `assigneeNameById` resolves each card's
// `assigneeId` to a display name (the projection card carries only the id —
// Story 3.1.4).

export function BoardColumn({
  column,
  assigneeNameById,
  onOpenQuickView,
}: {
  column: BoardColumnDto;
  assigneeNameById: Map<string, string>;
  onOpenQuickView: (identifier: string) => void;
}) {
  const t = useTranslations('boards');
  // The whole column is the droppable, so a drop anywhere in it (incl. the empty
  // body) resolves to this column; the card SortableContext handles the slot.
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    // The column caps its height to the available screen height (viewport minus
    // the top nav + page header + gutters ≈ 12rem) so it uses the full screen on
    // tall displays, and its card body scrolls internally — per-column scroll, no
    // fixed 560px cap that ends mid-screen. While a card is dragged over, the
    // accent ring + lavender tint mark it as the drop target (paired cues).
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
        {/* WIP-limit slot — a count/limit placeholder; Story 3.3 enforces it. */}
        {column.wipLimit != null ? (
          <span
            className="font-mono text-[11px] font-semibold text-(--el-text-faint)"
            title={t('wipTitle')}
            data-testid={`board-wip-${column.id}`}
          >
            {column.totalCount}/{column.wipLimit}
          </span>
        ) : null}
        {/* Column actions — a disabled seam (board/column admin is not v1). */}
        <button
          type="button"
          disabled
          aria-label={t('columnActions')}
          title={t('columnActionsComingSoon')}
          className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) disabled:cursor-not-allowed disabled:opacity-50"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </header>

      <div className="flex flex-col gap-2 overflow-y-auto p-2.5">
        {column.cards.length === 0 ? (
          <p className="my-1 rounded-(--radius-card) border border-dashed border-(--el-border) px-2.5 py-4 text-center text-xs text-(--el-text-muted)">
            {t('emptyColumn')}
          </p>
        ) : (
          <SortableContext
            items={column.cards.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {column.cards.map((card) => (
              <BoardCard
                key={card.id}
                card={card}
                assigneeName={
                  card.assigneeId ? (assigneeNameById.get(card.assigneeId) ?? null) : null
                }
                onOpenQuickView={onOpenQuickView}
              />
            ))}
          </SortableContext>
        )}
      </div>
    </section>
  );
}
