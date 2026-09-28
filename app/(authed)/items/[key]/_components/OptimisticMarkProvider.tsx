'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import { ObsolescenceHeaderLink } from '@/components/issues/ObsolescenceBadge';

// THE ITEM PAGE'S OPTIMISTIC OBSOLESCENCE CHANNEL (Story MOTIR-6575 · MOTIR-6674,
// found by MOTIR-6680's recording).
//
// The mark is WRITTEN in one client island (the core fields rail) and DRAWN in a
// second surface the server renders (the header badge). The rail keeps its own
// optimistic value and must not `router.refresh()` on success (the inline-edit
// rule in `CoreFieldsPanel`), so without a channel the header would say nothing
// until the next full render. This is `OptimisticStatusProvider`'s shape for the
// mark: the rail applies the value its write's 200 confirmed, and the header draws
// it at once.
//
// ⚠️ THE SERVER STILL WINS, by the same BASELINE rule: an override is honoured
// only while the server reads the mark it was applied over. The first server
// render carrying anything else — the written value, or one that disagrees —
// retires it in that same render.

interface MarkOverride {
  readonly optimistic: WorkItemObsolescenceDto | null;
  readonly baseline: WorkItemObsolescenceDto | null;
}

interface OptimisticMarkContextValue {
  readonly mark: WorkItemObsolescenceDto | null;
  applyOptimisticMark: (mark: WorkItemObsolescenceDto | null) => void;
}

const OptimisticMarkContext = createContext<OptimisticMarkContextValue | null>(null);

export function OptimisticMarkProvider({
  serverMark,
  children,
}: {
  serverMark: WorkItemObsolescenceDto | null;
  children: ReactNode;
}) {
  const [override, setOverride] = useState<MarkOverride | null>(null);
  const applyOptimisticMark = useCallback(
    (mark: WorkItemObsolescenceDto | null) =>
      setOverride({ optimistic: mark, baseline: serverMark }),
    [serverMark],
  );
  const mark = override && override.baseline === serverMark ? override.optimistic : serverMark;
  return (
    <OptimisticMarkContext.Provider value={{ mark, applyOptimisticMark }}>
      {children}
    </OptimisticMarkContext.Provider>
  );
}

const NOOP = () => {};

/** The rail's half: publish a confirmed write. Outside a provider (a surface
 *  rendering the rail on its own) it does nothing. */
export function useApplyOptimisticMark(): (mark: WorkItemObsolescenceDto | null) => void {
  return useContext(OptimisticMarkContext)?.applyOptimisticMark ?? NOOP;
}

/** The header's half: the badge link while the card is marked, nothing otherwise. */
export function OptimisticObsolescenceHeaderLink({
  serverMark,
}: {
  serverMark: WorkItemObsolescenceDto | null;
}) {
  const ctx = useContext(OptimisticMarkContext);
  // ⚠️ A CLEARED mark is `null`, so this must ask whether there IS a channel —
  // `ctx?.mark ?? serverMark` would read a clear as "no channel" and redraw the
  // server's stale mark.
  const mark = ctx ? ctx.mark : serverMark;
  return mark ? <ObsolescenceHeaderLink mark={mark} /> : null;
}
