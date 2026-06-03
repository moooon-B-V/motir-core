'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
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
}

const CreateIssueContext = createContext<CreateIssueContextValue | null>(null);

export function CreateIssueProvider({
  hasProject,
  children,
}: {
  hasProject: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  // "C" opens the modal — but only when NOT typing (so a literal "c" in a text
  // field stays a character) and only when there's a project to create into.
  useShortcut(SHORTCUTS.createIssue.combo, () => setOpen(true), { enabled: hasProject });

  const value = useMemo<CreateIssueContextValue>(
    () => ({
      open,
      setOpen,
      openCreateIssue: () => setOpen(true),
      canCreate: hasProject,
    }),
    [open, hasProject],
  );

  return (
    <CreateIssueContext.Provider value={value}>
      {children}
      {hasProject && <CreateIssueModal open={open} onOpenChange={setOpen} />}
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
