'use client';

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

// THE WORKBENCH, BROUGHT CURRENT FROM OUTSIDE IT (Story MOTIR-8539 · Subtask
// MOTIR-8576).
//
// An approve in the planning overlay commits work items, and the Workbench behind
// the overlay has to show them when it closes. That used to be a route refresh —
// the shell's coordinated one, held to one in flight because two overlapping
// refreshes made Next fall back to a full document load (MOTIR-6640). The
// Workbench now holds its own state and re-reads it in place
// (`useWorkbenchWindow`'s `reread`), so the overlay asks for THAT instead.
//
// ⚠️ THE PROVIDER SITS IN THE SHELL, NOT IN THE WORKBENCH VIEW. The planning
// overlay is mounted once in `app/(authed)/layout.tsx`, so the view inside
// `/workbench` is not its ancestor and a provider there would never reach it. So
// the shell's live host (`WorkbenchLive`, mounted in the layout above both) holds
// the provider, the view REGISTERS its `reread` while it is mounted
// (`useRegisterWorkbenchReread`), and a request reads through whichever view is
// registered — or does nothing when none is (any page that is not the Workbench).
//
// ⚠️ IT ADDS NO READ POLICY. A request calls the view's own `reread`, so the one
// read in flight, the abort and the monotonic order stay `useWorkbenchWindow`'s:
// an approve's request during a stream nudge's read collapses into it. Nor is it a
// module-level singleton — two shells never share one registration.

type Reread = () => void;

/** The slot: one registered `reread`, or none. */
class RereadRegistry {
  private reread: Reread | null = null;

  register(reread: Reread): () => void {
    this.reread = reread;
    return () => {
      if (this.reread === reread) this.reread = null;
    };
  }

  request(): void {
    this.reread?.();
  }
}

/** Outside any provider: nothing ever registers, so a request does nothing. */
const QUIET = new RereadRegistry();

const WorkbenchRereadContext = createContext<RereadRegistry | null>(null);

/** The shell's slot for the mounted Workbench view's `reread`. */
export function WorkbenchRereadProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new RereadRegistry());
  return createElement(WorkbenchRereadContext.Provider, { value: registry }, children);
}

/** Register `reread` as the Workbench's for as long as the caller is mounted. */
export function useRegisterWorkbenchReread(reread: Reread): void {
  const registry = useContext(WorkbenchRereadContext);
  useEffect(() => registry?.register(reread), [registry, reread]);
}

/**
 * Ask the mounted Workbench to re-read its window and counts. A no-op when no
 * Workbench is mounted, and outside any provider — the seam's QUIET default.
 */
export function useRequestWorkbenchReread(): Reread {
  const registry = useContext(WorkbenchRereadContext) ?? QUIET;
  return useCallback(() => registry.request(), [registry]);
}
