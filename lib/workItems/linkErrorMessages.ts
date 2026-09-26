import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { WorkItemLinkError } from '@/lib/workItems/linkErrors';

// A minimal translator shape — satisfied by next-intl's `getTranslations('errors')`
// result — so this pure mapper stays free of a direct next-intl import / request
// access. The caller (a Server Action) resolves the translator and passes it in.
type ErrorTranslator = (key: string, values?: Record<string, string | number>) => string;

// Maps the typed work-item-link errors to a `links.*` catalog key, resolved by
// the passed-in translator. Shared by BOTH link surfaces' Server Actions — the
// detail-page add/remove (`issues/[key]/actions.ts`, Subtask 2.4.9) and the
// create-modal collect-on-create (`issues/actions.ts`, Subtask 2.4.10) — so the
// inline copy stays in one place (a 'use server' module can only export async
// actions, so this can't live in either action file). The service throws the
// typed errors; the action layer turns them into the inline message the
// relationships add-form / create-modal surfaces show. Returns null when `err`
// isn't a link/not-found error so the caller can rethrow it (a genuine 500),
// not swallow it.
export function linkErrorMessage(err: unknown, t: ErrorTranslator): string | null {
  if (err instanceof WorkItemNotFoundError) return t('links.notFound');
  if (err instanceof WorkItemLinkError) {
    switch (err.code) {
      case 'SELF_LINK':
        return t('links.selfLink');
      case 'DUPLICATE_LINK':
        return t('links.duplicate');
      case 'WORK_ITEM_LINK_CYCLE':
        return t('links.cycle');
      case 'CROSS_WORKSPACE_LINK':
      case 'WORKSPACE_MISMATCH_LINK':
        return t('links.crossWorkspace');
      case 'WORK_ITEM_LINK_NOT_FOUND':
        return t('links.linkNotFound');
      default:
        return t('links.couldNotUpdate');
    }
  }
  return null;
}
