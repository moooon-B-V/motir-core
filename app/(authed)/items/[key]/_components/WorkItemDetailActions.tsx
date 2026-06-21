'use client';

import { useRouter } from 'next/navigation';
import { WorkItemActionsMenu } from '@/components/issues/actions/WorkItemActionsMenu';

// The detail-header ⋯ actions menu (Story 2.8 · Subtask 2.8.4) — the client
// wrapper that gives the shared menu its detail-surface page-state: after a
// DELETE the viewed item is gone, and after an ARCHIVE it has left the active
// views, so either way we navigate back to the issues list (the Undo toast is
// the restore path for archive). `router.refresh()` re-reads the now-shorter
// list. Replaces the old bare "Edit" link — "Edit details" lives inside the menu.
//
// On an ARCHIVED item's detail page (Story 2.9 · Subtask 2.9.11) the menu is in
// `archived` mode: the canEdit row is Restore, and Delete… opens the archived
// confirm. A detail Restore does NOT leave — it `router.refresh()`es in place so
// the now-active item stays on screen and the archived banner (2.9.6) clears,
// matching the banner's own Restore page-state. Delete still navigates away.
export function WorkItemDetailActions({
  itemId,
  identifier,
  title,
  canEdit,
  canManage,
  archived = false,
  activeSprintId = null,
  activeSprintName = null,
  inActiveSprint = false,
}: {
  itemId: string;
  identifier: string;
  title: string;
  canEdit: boolean;
  canManage: boolean;
  /** The item is archived — put the menu in Restore/archived-delete mode. */
  archived?: boolean;
  /** The project's active sprint (the "Add to active sprint" target — 2.4.14). */
  activeSprintId?: string | null;
  activeSprintName?: string | null;
  /** Whether this item is already in the active sprint (disables the row). */
  inActiveSprint?: boolean;
}) {
  const router = useRouter();
  const leave = () => {
    router.push('/items');
    router.refresh();
  };
  // Archived detail: the menu's only canEdit action is Restore, which keeps the
  // item on this page (now active) — re-read in place rather than leaving.
  const refreshInPlace = () => router.refresh();
  return (
    <WorkItemActionsMenu
      itemId={itemId}
      identifier={identifier}
      title={title}
      canEdit={canEdit}
      canManage={canManage}
      archived={archived}
      activeSprintId={activeSprintId}
      activeSprintName={activeSprintName}
      inActiveSprint={inActiveSprint}
      // The Sprint field is a server-prop surface (CoreFieldsPanel reads `item`),
      // so a refresh re-reads the new sprintId into the rail — page-state #2.
      onSprintChanged={() => router.refresh()}
      onDeleted={leave}
      onArchived={archived ? refreshInPlace : leave}
      triggerClassName="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) border border-(--el-border) text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    />
  );
}
