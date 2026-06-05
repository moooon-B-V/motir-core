import {
  WorkItemError,
  WorkItemNotFoundError,
  UnknownStatusError,
  IllegalTransitionError,
} from '@/lib/workItems/errors';

// A minimal translator shape — satisfied by next-intl's `getTranslations('errors')`
// result — so this pure mapper stays free of any next-intl import / request
// access. The Server Action resolves the translator and passes it in (the same
// seam linkErrorMessage uses).
type ErrorTranslator = (key: string, values?: Record<string, string | number>) => string;

// Maps a typed WorkItemError to its translated, user-facing message. The error
// classes carry a stable `code` + (for the interpolating ones) structured fields,
// so the message resolves to `errors.workItems.<CODE>` with params — the error
// objects never hold a localized string themselves. Exhaustive over the tags.
export function workItemErrorMessage(err: WorkItemError, t: ErrorTranslator): string {
  if (err instanceof WorkItemNotFoundError) {
    return t('workItems.WORK_ITEM_NOT_FOUND', { id: err.idOrIdentifier });
  }
  if (err instanceof UnknownStatusError) {
    return t('workItems.UNKNOWN_STATUS', { statusKey: err.statusKey });
  }
  if (err instanceof IllegalTransitionError) {
    return t('workItems.ILLEGAL_TRANSITION', { from: err.fromKey, to: err.toKey });
  }
  // The remaining tags carry no interpolated values — key straight off `code`.
  return t(`workItems.${err.code}`);
}
