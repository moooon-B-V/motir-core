'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Activity } from 'lucide-react';
import { WorkItemActionsMenu } from '@/components/issues/actions/WorkItemActionsMenu';
import { useMonitorErrorsDoor } from './MonitorErrorsLinkControl';

// The detail-header ⋯ actions menu (Story 2.8 · Subtask 2.8.4) — the client
// wrapper that gives the shared menu its detail-surface page-state: after a
// DELETE the viewed item is gone, and after an ARCHIVE it has left the active
// views, so either way we navigate back to the issues list (the Undo toast is
// the restore path for archive). `router.refresh()` re-reads the now-shorter
// list. Replaces the old bare "Edit" link — "Edit details" lives inside the menu.
//
// On an ARCHIVED item's detail page (Story 2.9 · Subtask 2.9.11) the menu is in
// `archived` mode: the canArchive row is Restore, and Delete… opens the archived
// confirm. A detail Restore does NOT leave — it `router.refresh()`es in place so
// the now-active item stays on screen and the archived banner (2.9.6) clears,
// matching the banner's own Restore page-state. Delete still navigates away.
export function WorkItemDetailActions({
  itemId,
  identifier,
  title,
  canEdit,
  canArchive,
  canDelete,
  archived = false,
  activeSprintId = null,
  activeSprintName = null,
  inActiveSprint = false,
}: {
  itemId: string;
  identifier: string;
  title: string;
  canEdit: boolean;
  /** `work_item:archive` — Archive / Restore, and the delete dialog's "Archive
   *  instead" escape-hatch (MOTIR-3629 split it out of `canDelete`, which had
   *  hidden the row from every member). */
  canArchive: boolean;
  /** `work_item:delete` — the Delete row (MOTIR-2473 renamed this from
   *  `canManage`, which carried `project:administer`; MOTIR-3629 took Archive
   *  off it). */
  canDelete: boolean;
  /** The item is archived — put the menu in Restore/archived-delete mode. */
  archived?: boolean;
  /** The project's active sprint (the "Add to active sprint" target — 2.4.14). */
  activeSprintId?: string | null;
  activeSprintName?: string | null;
  /** Whether this item is already in the active sprint (disables the row). */
  inActiveSprint?: boolean;
}) {
  const router = useRouter();
  const t = useTranslations('workItemActions');
  // THE NO-LINK ERRORS DOOR (MOTIR-5744, design `design/monitoring` §14 Decision 1):
  // present only where the late Errors read has said it applies — an editor, a
  // monitored project, and no link yet. Choosing it mounts the Errors section with
  // the picker open. Passed from THIS wrapper only, so the shared menu on board
  // cards and list rows does not gain it.
  const errorsDoor = useMonitorErrorsDoor();
  const linkErrorAction =
    errorsDoor?.available && !archived
      ? {
          label: t('linkError'),
          icon: <Activity className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />,
          onSelect: errorsDoor.request,
        }
      : null;
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
      canArchive={canArchive}
      canDelete={canDelete}
      archived={archived}
      activeSprintId={activeSprintId}
      activeSprintName={activeSprintName}
      inActiveSprint={inActiveSprint}
      // The Sprint field is a server-prop surface (CoreFieldsPanel reads `item`),
      // so a refresh re-reads the new sprintId into the rail — page-state #2.
      onSprintChanged={() => router.refresh()}
      onDeleted={leave}
      onArchived={archived ? refreshInPlace : leave}
      hostAction={linkErrorAction}
      triggerClassName="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) border border-(--el-border) text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    />
  );
}
