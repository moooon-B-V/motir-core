import type { PermissionKey } from '@/lib/permissions/catalog';

/**
 * The three rooms a view-any key opens WHOLE (MOTIR-6328), in the Roles page's
 * order: Plans · Approvals · Runs.
 *
 * A DISPLAY constant, kept apart from the catalog on purpose: the Roles screens
 * read the model only through the service (`rolesStoryGate`), and a screen that
 * shows which rooms a role opens must not spell a key a service reads — the
 * approval key is read in exactly one service place
 * (`approvalGatesService.listRecords`, `approval-records-story-gate`).
 */
export const ROOM_VIEW_KEYS = {
  plans: 'plan:view_any',
  approvals: 'approval:view_any',
  runs: 'run:view_any',
} as const satisfies Record<string, PermissionKey>;
