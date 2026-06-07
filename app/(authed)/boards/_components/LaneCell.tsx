'use client';

import { useTranslations } from 'next-intl';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useRowWindow } from '@/components/ui/useRowWindow';
import type { BoardCardDto } from '@/lib/dto/boards';
import { BoardCard } from './BoardCard';
import { cellId } from './boardSwimlanes';

// LaneCell (Subtask 3.3.5) — one `(column × lane)` cell of the swimlane grid per
// `design/boards/swimlanes-wip.mock.html` (`.lane-col`). It is the swimlane
// analogue of a flat column's card stack: a dnd-kit DROPPABLE keyed by
// `cellId(columnId, laneKey)` (so a drop resolves to BOTH the column → workflow
// transition AND the lane → field reassign, the cross-lane-drag contract) over a
// vertical `SortableContext` of this cell's bucketed cards.
//
// It REUSES the shipped `BoardCard` (3.2.3) unchanged and the SAME 2.5.15
// windowing primitive (`useRowWindow`) the flat column uses — NO second
// virtualization lib (the AC). Cells don't scroll internally (the board's
// page/horizontal scroll is the viewport), so the window measures against the
// nearest scroll parent; when the cell's cards fit (the common case — a lane
// holds a slice of a column) windowing is inert and every card mounts. The
// `SortableContext` items list stays the FULL cell order so dnd-kit knows every
// card's rank even when only a window mounts, and the dragged card (+ neighbours)
// is force-mounted so a drag never detaches. Empty cells render the dashed
// "No issues" placeholder from the mock.

const CARD_ESTIMATE_PX = 116; // matches BoardColumn — pre-measure card height
const CARD_GAP_PX = 8;
const DRAG_KEEP = 2;

export function LaneCell({
  columnId,
  laneKey,
  cards,
  assigneeNameById,
  onOpenQuickView,
  activeCardId,
}: {
  columnId: string;
  laneKey: string;
  cards: BoardCardDto[];
  assigneeNameById: Map<string, string>;
  onOpenQuickView: (identifier: string) => void;
  activeCardId: string | null;
}) {
  const t = useTranslations('boards');
  const id = cellId(columnId, laneKey);
  const { setNodeRef, isOver } = useDroppable({ id });

  const empty = cards.length === 0;

  // No explicit scroll element: a cell doesn't scroll internally (the board's
  // page scroll is the viewport), so the window measures against the nearest
  // scrollable ancestor the hook finds — exactly the page/main scroller.
  const { containerRef, range, totalSize, getOffset, measureElement, windowing } = useRowWindow({
    count: cards.length,
    estimateRowHeight: CARD_ESTIMATE_PX,
    gap: CARD_GAP_PX,
  });

  // Window indices + the dragged card and its neighbours (so a drag never
  // detaches mid-flight) — the exact rule BoardColumn uses. Whole cell when not
  // windowing (the common small-cell case, and under happy-dom in tests).
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

  if (empty) {
    return (
      <div
        ref={setNodeRef}
        data-testid={`lane-cell-${columnId}-${laneKey}`}
        data-over={isOver ? 'true' : undefined}
        className={`flex min-h-[28px] w-72 shrink-0 items-center justify-center rounded-(--radius-card) border border-dashed px-2.5 py-4 text-center text-xs transition-colors ${
          isOver
            ? 'border-(--el-accent) bg-(--el-tint-lavender) text-(--el-text-strong) outline outline-2 outline-(--el-accent)'
            : 'border-(--el-border) text-(--el-text-muted)'
        }`}
      >
        {t('emptyColumn')}
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      data-testid={`lane-cell-${columnId}-${laneKey}`}
      data-over={isOver ? 'true' : undefined}
      className={`w-72 shrink-0 rounded-(--radius-card) transition-colors ${
        isOver ? 'bg-(--el-tint-lavender) outline outline-2 outline-(--el-accent)' : ''
      }`}
    >
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
      </SortableContext>
    </div>
  );
}
