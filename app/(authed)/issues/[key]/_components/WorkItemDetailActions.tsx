'use client';

import { useRouter } from 'next/navigation';
import { WorkItemActionsMenu } from '@/components/issues/actions/WorkItemActionsMenu';

// The detail-header ⋯ actions menu (Story 2.8 · Subtask 2.8.4) — the client
// wrapper that gives the shared menu its detail-surface page-state: after a
// DELETE the viewed item is gone, and after an ARCHIVE it has left the active
// views, so either way we navigate back to the issues list (the Undo toast is
// the restore path for archive). `router.refresh()` re-reads the now-shorter
// list. Replaces the old bare "Edit" link — "Edit details" lives inside the menu.
export function WorkItemDetailActions({
  itemId,
  identifier,
  title,
  canEdit,
  canManage,
}: {
  itemId: string;
  identifier: string;
  title: string;
  canEdit: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const leave = () => {
    router.push('/issues');
    router.refresh();
  };
  return (
    <WorkItemActionsMenu
      itemId={itemId}
      identifier={identifier}
      title={title}
      canEdit={canEdit}
      canManage={canManage}
      onDeleted={leave}
      onArchived={leave}
      triggerClassName="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) border border-(--el-border) text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    />
  );
}
