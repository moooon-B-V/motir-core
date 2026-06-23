'use client';

import { WorkItemActionsMenu } from '@/components/issues/actions/WorkItemActionsMenu';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';
import { useNotifyIssuesChanged } from '../../_components/CreateIssueProvider';
import type { IssueRowData } from './issueRows';

// The trailing list/tree row-actions cell (Story 2.8 · Subtask 2.8.4) — the
// shared ⋯ actions menu (Edit details · Copy link · Archive · Delete…). Caps
// come from `useProjectAccess()` (resolved once in the authed layout), so the
// menu gates Archive on `canEdit` and Delete on `canManage` without per-row
// threading. Page state after a delete/archive: bump the `issuesChangedAt` tick
// — the Tree/List is a client island (IssueTreeTable) that refetches on it, the
// page-state-after-mutation contract for an island. (The quick-view eye that
// used to lead this cell was removed in MOTIR-1306 — a plain row click now opens
// the peek, making the per-row trigger redundant.)
export function WorkItemRowActions({ row }: { row: IssueRowData }) {
  const { canEdit, canManage } = useProjectAccess();
  const notifyIssuesChanged = useNotifyIssuesChanged();

  return (
    <span className="flex items-center justify-end gap-0.5">
      <WorkItemActionsMenu
        itemId={row.id}
        identifier={row.identifier}
        title={row.title}
        canEdit={canEdit}
        canManage={canManage}
        onDeleted={notifyIssuesChanged}
        onArchived={notifyIssuesChanged}
      />
    </span>
  );
}
