'use client';

import { createContext, useContext, useRef } from 'react';
import { StatusHeldNotice, type StatusHeldLine } from '@/components/issues/StatusHeldNotice';
import { useDismissOnEscapeOrOutside } from '@/components/issues/heldRefusal';

// The board's HELD refusal, anchored ON the returned card (Story MOTIR-4887 ·
// Subtask MOTIR-5529; `design/boards/design-notes.md` § panel 2b).
//
// `BoardContainer` owns the state (it is the one that sees the 409); the card that
// was refused renders the line directly under itself. A context rather than a prop
// threaded through `BoardColumn`, `SwimlaneBoard` and `LaneCell`: exactly one card
// on the board can be showing it, and the flat and swimlane layouts reach cards by
// different paths.

export interface BoardHeldRefusal {
  workItemId: string;
  itemKey: string;
  line: StatusHeldLine;
}

export interface BoardHeldRefusalContextValue {
  held: BoardHeldRefusal | null;
  close: () => void;
}

/** Outside a board (a card rendered on its own): nothing held, nothing to close. */
export const NO_BOARD_HELD_REFUSAL: BoardHeldRefusalContextValue = {
  held: null,
  close: () => {},
};

const BoardHeldRefusalContext = createContext<BoardHeldRefusalContextValue>(NO_BOARD_HELD_REFUSAL);

export const BoardHeldRefusalProvider = BoardHeldRefusalContext.Provider;

/** Rendered by `BoardCard` under itself — draws nothing unless THIS card was the
 *  one refused. Closes on `Esc` or a click outside (the next drag start closes it
 *  from the container). */
export function BoardCardHeldRefusal({ workItemId }: { workItemId: string }) {
  const { held, close } = useContext(BoardHeldRefusalContext);
  const ref = useRef<HTMLDivElement>(null);
  const open = held?.workItemId === workItemId;
  useDismissOnEscapeOrOutside(ref, open, close);
  if (!open || !held) return null;
  return (
    <div
      ref={ref}
      data-board-held=""
      className="mt-2 rounded-(--radius-control) shadow-(--shadow-elevated)"
    >
      <StatusHeldNotice itemKey={held.itemKey} lines={[held.line]} />
    </div>
  );
}
