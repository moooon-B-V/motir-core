'use client';

import { NewRootFolderButton } from '@/components/folders/FolderCommands';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';

/**
 * The /items toolbar's "New folder" (Story MOTIR-5308 · MOTIR-5344, the design's
 * panel 1) — a secondary button beside the primary "New work item". The toolbar
 * places it in the unfiltered Tree view only; it renders only for a member
 * holding `work_item:edit`, the key `foldersService.createFolder` asserts. The
 * button itself is the shared `NewRootFolderButton` (MOTIR-7374 moved the folder
 * commands to `components/folders/`); this wrapper is the /items gate.
 */
export function NewFolderButton() {
  const { can } = useProjectAccess();
  if (!can('work_item:edit')) return null;
  return <NewRootFolderButton />;
}
