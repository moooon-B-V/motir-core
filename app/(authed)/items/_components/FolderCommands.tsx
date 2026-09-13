'use client';

import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { FolderPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';

// The channel between the /items TOOLBAR and the tree island (Story MOTIR-5308 ·
// MOTIR-5344). The toolbar's "New folder" creates at the project root, but the
// name row it opens — and the level the created folder lands in — belong to the
// lazy tree, a client island rendered in a different branch of the page. The
// tree REGISTERS the command while it is mounted; the button only asks for it.
// A registration rather than a state tick, so no effect ever sets state in
// response to a button press elsewhere on the page.
//
// It also carries PLACEMENT reports (MOTIR-5353): when something else on the
// page — the quick view's Folder field — changes where a work item sits, it
// reports the new placement, and the tree moves that row in place. Same shape:
// the tree registers while mounted, a caller reports, and a report with no tree
// registered (the peek on /ready or /boards) does nothing.

/** Where a work item now sits: in a folder, under a work item, or at the root. */
export interface WorkItemPlacement {
  workItemId: string;
  folderId: string | null;
  parentId: string | null;
}

interface FolderCommandsValue {
  /** Ask the mounted tree to open a name row for a new ROOT folder. */
  requestNewRootFolder: () => void;
  /** The tree registers its handler on mount and clears it on unmount. */
  registerNewRootFolder: (handler: (() => void) | null) => void;
  /** Tell the mounted tree a work item's placement changed. */
  reportWorkItemPlacement: (placement: WorkItemPlacement) => void;
  /** The tree registers its placement handler on mount and clears it on unmount. */
  registerPlacementHandler: (handler: ((placement: WorkItemPlacement) => void) | null) => void;
}

const FolderCommandsContext = createContext<FolderCommandsValue | null>(null);

export function FolderCommandsProvider({ children }: { children: ReactNode }) {
  const handler = useRef<(() => void) | null>(null);
  const placementHandler = useRef<((placement: WorkItemPlacement) => void) | null>(null);
  const requestNewRootFolder = useCallback(() => handler.current?.(), []);
  const registerNewRootFolder = useCallback((next: (() => void) | null) => {
    handler.current = next;
  }, []);
  const reportWorkItemPlacement = useCallback(
    (placement: WorkItemPlacement) => placementHandler.current?.(placement),
    [],
  );
  const registerPlacementHandler = useCallback(
    (next: ((placement: WorkItemPlacement) => void) | null) => {
      placementHandler.current = next;
    },
    [],
  );
  const value = useMemo(
    () => ({
      requestNewRootFolder,
      registerNewRootFolder,
      reportWorkItemPlacement,
      registerPlacementHandler,
    }),
    [
      requestNewRootFolder,
      registerNewRootFolder,
      reportWorkItemPlacement,
      registerPlacementHandler,
    ],
  );
  return <FolderCommandsContext.Provider value={value}>{children}</FolderCommandsContext.Provider>;
}

/** The folder command channel, or `null` outside a provider (a unit-rendered tree). */
export function useFolderCommands(): FolderCommandsValue | null {
  return useContext(FolderCommandsContext);
}

/**
 * The toolbar's "New folder" (the design's panel 1) — a secondary button beside
 * the primary "New work item". The toolbar places it in the unfiltered Tree view
 * only; it renders only for a member holding `work_item:edit`, the key
 * `foldersService.createFolder` asserts.
 */
export function NewFolderButton() {
  const t = useTranslations('folders');
  const commands = useFolderCommands();
  const { can } = useProjectAccess();
  if (!commands || !can('work_item:edit')) return null;
  return (
    <Button
      variant="secondary"
      leftIcon={<FolderPlus className="h-4 w-4" aria-hidden />}
      onClick={commands.requestNewRootFolder}
    >
      {t('newFolder')}
    </Button>
  );
}
