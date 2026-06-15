'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

// The board filter UI's shared open state (Story 6.15 · Subtask 6.15.3). The
// quick `[Filter]` popover (IssueFilterBar) lives in the board's HEADER toolbar,
// but the over-cap banner's "Refine filter" CTA — rendered DEEP inside
// BoardContainer (a different subtree) — must be able to open it (the CTA used
// to point at the dead `[Filter]` seam; now it opens the live filter). A tiny
// page-scoped context lifts that one boolean so the two subtrees share it,
// exactly the shape `AdvancedFilterProvider` uses for the builder popover.
//
// Outside a provider the hook returns null (not a throw): BoardContainer + the
// filter controls also render in isolated unit tests, where the bar falls back
// to its own internal open state and the over-cap CTA is a no-op (disabled).

export interface BoardFilterUiState {
  /** Whether the quick `[Filter]` popover is open. */
  filterOpen: boolean;
  setFilterOpen: (open: boolean) => void;
}

const BoardFilterUiContext = createContext<BoardFilterUiState | null>(null);

export function useBoardFilterUi(): BoardFilterUiState | null {
  return useContext(BoardFilterUiContext);
}

export function BoardFilterUiProvider({ children }: { children: ReactNode }) {
  const [filterOpen, setFilterOpen] = useState(false);
  const value = useMemo(() => ({ filterOpen, setFilterOpen }), [filterOpen]);
  return <BoardFilterUiContext.Provider value={value}>{children}</BoardFilterUiContext.Provider>;
}
