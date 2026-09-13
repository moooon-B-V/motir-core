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

interface FolderCommandsValue {
  /** Ask the mounted tree to open a name row for a new ROOT folder. */
  requestNewRootFolder: () => void;
  /** The tree registers its handler on mount and clears it on unmount. */
  registerNewRootFolder: (handler: (() => void) | null) => void;
}

const FolderCommandsContext = createContext<FolderCommandsValue | null>(null);

export function FolderCommandsProvider({ children }: { children: ReactNode }) {
  const handler = useRef<(() => void) | null>(null);
  const requestNewRootFolder = useCallback(() => handler.current?.(), []);
  const registerNewRootFolder = useCallback((next: (() => void) | null) => {
    handler.current = next;
  }, []);
  const value = useMemo(
    () => ({ requestNewRootFolder, registerNewRootFolder }),
    [requestNewRootFolder, registerNewRootFolder],
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
