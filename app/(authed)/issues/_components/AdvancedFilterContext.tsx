'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

// The advanced-filter popover's open state, shared across the /issues page
// (Subtask 6.1.4): the [Advanced] toolbar trigger owns the Popover, but two
// surfaces OUTSIDE the toolbar also open it — the applied summary's condition
// chips under the header, and the facet popover's "Edit in Advanced" upgrade
// footer. A context (page-scoped, provided by the Server Component page with
// pass-through children) lets them share the one flag without lifting the
// whole builder out of the toolbar.
//
// Outside a provider the hook returns null (not a throw): the filter bar and
// the builder also render standalone in component tests — the bar's hand-off
// becomes a no-op and the builder falls back to local open state.

export interface AdvancedFilterPopoverState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const AdvancedFilterPopoverContext = createContext<AdvancedFilterPopoverState | null>(null);

export function useAdvancedFilterPopover(): AdvancedFilterPopoverState | null {
  return useContext(AdvancedFilterPopoverContext);
}

export function AdvancedFilterProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <AdvancedFilterPopoverContext.Provider value={value}>
      {children}
    </AdvancedFilterPopoverContext.Provider>
  );
}
