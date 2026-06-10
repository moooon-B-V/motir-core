import {
  CustomFieldTextTooLongError,
  type CustomFieldValueError,
} from '@/lib/customFields/valueErrors';

// Maps a typed custom-field VALUE error to its translated, user-facing message
// (the workItemErrorMessage seam): the classes carry a stable `code`, the
// message resolves to `errors.customFields.<CODE>`, and the Server Action
// resolves the translator and passes it in — the error objects never hold a
// localized string themselves.

type ErrorTranslator = (key: string, values?: Record<string, string | number>) => string;

export function customFieldValueErrorMessage(
  err: CustomFieldValueError,
  t: ErrorTranslator,
): string {
  if (err instanceof CustomFieldTextTooLongError) {
    return t('customFields.TEXT_TOO_LONG', { max: err.max });
  }
  // The remaining tags carry no interpolated values — key straight off `code`.
  return t(`customFields.${err.code}`);
}
