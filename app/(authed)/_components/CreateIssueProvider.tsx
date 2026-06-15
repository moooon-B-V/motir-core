'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useShortcut } from '@/lib/hooks/useShortcut';
import { SHORTCUTS } from '@/lib/shortcuts';
import { CreateIssueModal } from './CreateIssueModal';

/**
 * CreateIssueProvider — owns the open state of the create-issue modal and
 * registers its global "C" shortcut once for the whole authenticated shell
 * (mirrors CommandPaletteProvider's pattern). It exposes `openCreateIssue()`
 * and `canCreate` via context so the three entry points — the top-nav "+"
 * button, the "C" shortcut (here), and the ⌘K "Create issue" command — all
 * drive the same dialog without prop-drilling.
 *
 * `canCreate` is false when there's no active project (a brand-new workspace);
 * the "C" shortcut is disabled and the button + command gate on it, since an
 * issue needs a project to belong to.
 */
interface CreateIssueContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  openCreateIssue: () => void;
  canCreate: boolean;
  /**
   * A monotonically increasing tick bumped each time a work item is created,
   * deleted, or archived. Client-fetched surfaces (e.g. the board, which
   * `router.refresh()` can't reach) watch this to refetch. It carries no
   * payload — it's a "the item set changed, re-read if you cache" signal.
   */
  issuesChangedAt: number;
  /**
   * Bump `issuesChangedAt` from a mutation OTHER than create — a delete or
   * archive from the ⋯ actions menu (2.8.4), so a watching client island (the
   * board) refetches and drops the gone/archived item. Same signal the create
   * modal raises on a successful create.
   */
  notifyIssuesChanged: () => void;
}

const CreateIssueContext = createContext<CreateIssueContextValue | null>(null);

export function CreateIssueProvider({
  hasProject,
  canEdit = true,
  children,
}: {
  hasProject: boolean;
  /**
   * Whether the actor may EDIT the active project (Story 6.4.6). When false (a
   * viewer / a member on a limited project) the create modal is NOT mounted and
   * the "C" shortcut is disabled — the server rejects the create anyway, so a
   * read-only actor must not get a functional create path. The create BUTTONS
   * still render (disabled, via ProjectAccessProvider) so the affordance is
   * visible-but-blocked rather than absent. Defaults to true so non-shell /
   * test mounts keep their prior behaviour.
   */
  canEdit?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [issuesChangedAt, setIssuesChangedAt] = useState(0);

  // "C" opens the modal — but only when NOT typing (so a literal "c" in a text
  // field stays a character) and only when there's a project to create into.
  useShortcut(SHORTCUTS.createIssue.combo, () => setOpen(true), { enabled: hasProject && canEdit });

  // The modal calls this on a successful create; bumping the tick lets
  // client-fetched consumers refetch (the modal's own `router.refresh()` only
  // reaches Server Components).
  const notifyIssueCreated = useCallback(() => setIssuesChangedAt((n) => n + 1), []);

  const value = useMemo<CreateIssueContextValue>(
    () => ({
      open,
      setOpen,
      openCreateIssue: () => setOpen(true),
      canCreate: hasProject,
      issuesChangedAt,
      notifyIssuesChanged: notifyIssueCreated,
    }),
    [open, hasProject, issuesChangedAt, notifyIssueCreated],
  );

  return (
    <CreateIssueContext.Provider value={value}>
      {children}
      {hasProject && canEdit && (
        <CreateIssueModal open={open} onOpenChange={setOpen} onCreated={notifyIssueCreated} />
      )}
    </CreateIssueContext.Provider>
  );
}

export function useCreateIssue(): CreateIssueContextValue {
  const ctx = useContext(CreateIssueContext);
  if (!ctx) {
    throw new Error('useCreateIssue must be used inside <CreateIssueProvider>');
  }
  return ctx;
}

/**
 * A NON-throwing accessor for the "issues changed" notifier — returns a no-op
 * when rendered outside the provider (a unit test, or a surface with no board
 * island to refetch). The mutation cells that live deep in lists / board cards
 * (the 2.8.4 ⋯ menu) use THIS rather than `useCreateIssue()`, so a row/card
 * renders without requiring the whole create-issue provider just to mount.
 */
export function useNotifyIssuesChanged(): () => void {
  const ctx = useContext(CreateIssueContext);
  return ctx?.notifyIssuesChanged ?? (() => {});
}
