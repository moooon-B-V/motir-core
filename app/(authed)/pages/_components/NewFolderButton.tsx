'use client';

import { NewRootFolderButton } from '@/components/folders/FolderCommands';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';

// NEW FOLDER on `/pages` (Story MOTIR-5753 · MOTIR-7374) —
// `design/pages/pages--tree.mock.html` panels 1 and 4: the header's secondary
// button beside New page, and the empty state's second action. It is the shared
// `NewRootFolderButton` — it asks the page's tree, through the shared folder
// command channel, for a new root folder's inline name row, exactly as `/items`'
// toolbar does.
//
// ⚠️ RENDERED ONLY FOR A READER WHO HOLDS BOTH `page:edit` (the tree's write
// controls) AND `work_item:edit` (the key every `foldersService` write asserts).
// Hiding it is not the enforcement; the action's own gate is.

export function NewFolderButton() {
  const { can } = useProjectAccess();
  if (!can('page:edit') || !can('work_item:edit')) return null;
  return <NewRootFolderButton />;
}
