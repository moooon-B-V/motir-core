'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AppliedSavedFilter } from '@/lib/issues/savedFilterApplied';

// The /issues saved-filter SESSION state (Story 6.2 · Subtask 6.2.3) — shared
// between the toolbar's [Saved] dropdown (which sets the applied filter) and the
// summary-row name chip + Save/Save-as/Discard controls (which read it). Both
// live under this provider, mounted by the Server Component page, so neither has
// to lift the other out of its place in the toolbar / summary row.
//
// `applied` is which saved (or built-in) filter the user is currently "on"; it
// is NOT in the URL (the URL carries only the `?filter=v1:` AST — one state
// channel) and so survives client navigation but resets on a hard reload, which
// is exactly right (the filter itself reload-survives via the URL; the chip is a
// session affordance). `dropdownOpen` is lifted here so the name chip — rendered
// in the summary row, a different subtree — can open the dropdown anchored to the
// toolbar's [Saved] trigger.
//
// Outside a provider the hook returns null (not a throw): the dropdown and chip
// also render standalone in component tests, where they fall back to local state
// or simply render the uncontrolled default.

export interface SavedFilterSessionState {
  applied: AppliedSavedFilter | null;
  setApplied: (applied: AppliedSavedFilter | null) => void;
  dropdownOpen: boolean;
  setDropdownOpen: (open: boolean) => void;
}

const SavedFilterSessionContext = createContext<SavedFilterSessionState | null>(null);

export function useSavedFilterSession(): SavedFilterSessionState | null {
  return useContext(SavedFilterSessionContext);
}

export function SavedFilterSessionProvider({ children }: { children: ReactNode }) {
  const [applied, setApplied] = useState<AppliedSavedFilter | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const value = useMemo(
    () => ({ applied, setApplied, dropdownOpen, setDropdownOpen }),
    [applied, dropdownOpen],
  );
  return (
    <SavedFilterSessionContext.Provider value={value}>
      {children}
    </SavedFilterSessionContext.Provider>
  );
}
