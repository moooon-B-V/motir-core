import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { WorkItemLinkError } from '@/lib/workItems/linkErrors';

// One-line, user-facing messages for the typed work-item-link errors. Shared by
// BOTH link surfaces' Server Actions — the detail-page add/remove
// (`issues/[key]/actions.ts`, Subtask 2.4.9) and the create-modal collect-on-
// create (`issues/actions.ts`, Subtask 2.4.10) — so the inline copy stays in one
// place (a 'use server' module can only export async actions, so this can't live
// in either action file). The service throws the typed errors; the action layer
// turns them into the inline message the relationships add-form / create-modal
// surfaces show. Returns null when `err` isn't a link/not-found error so the
// caller can rethrow it (a genuine 500), not swallow it.
export function linkErrorMessage(err: unknown): string | null {
  if (err instanceof WorkItemNotFoundError) return 'That issue no longer exists.';
  if (err instanceof WorkItemLinkError) {
    switch (err.code) {
      case 'SELF_LINK':
        return "An issue can't link to itself.";
      case 'DUPLICATE_LINK':
        return 'That link already exists.';
      case 'WORK_ITEM_LINK_CYCLE':
        return 'That would create a dependency cycle.';
      case 'CROSS_WORKSPACE_LINK':
      case 'WORKSPACE_MISMATCH_LINK':
        return 'That issue is in another workspace.';
      case 'WORK_ITEM_LINK_NOT_FOUND':
        return 'That link no longer exists.';
      default:
        return 'Could not update the link.';
    }
  }
  return null;
}
