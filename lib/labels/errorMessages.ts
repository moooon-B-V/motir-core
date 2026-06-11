import {
  InvalidLabelNameError,
  LabelLimitExceededError,
  LabelNameTooLongError,
} from '@/lib/labels/errors';
import { LABEL_NAME_MAX_LENGTH, LABELS_PER_ISSUE_LIMIT } from '@/lib/labels/constants';

// A minimal translator shape — satisfied by next-intl's `getTranslations('errors')`
// result — so this pure mapper stays free of any next-intl import / request
// access (the workItemErrorMessage seam).
type ErrorTranslator = (key: string, values?: Record<string, string | number>) => string;

/** The label-domain error union the issue-field surfaces translate. */
export type LabelError = InvalidLabelNameError | LabelNameTooLongError | LabelLimitExceededError;

export function isLabelError(err: unknown): err is LabelError {
  return (
    err instanceof InvalidLabelNameError ||
    err instanceof LabelNameTooLongError ||
    err instanceof LabelLimitExceededError
  );
}

/**
 * Maps a typed label error to its translated, user-facing message
 * (`errors.labels.<CODE>`). `typedName` is the raw name the user submitted —
 * the no-spaces message interpolates its hyphenated form (the design's
 * "use a hyphen: perf-q3" copy); the error object itself carries no fields.
 */
export function labelErrorMessage(err: LabelError, t: ErrorTranslator, typedName = ''): string {
  if (err instanceof InvalidLabelNameError) {
    const suggestion = typedName.trim().replace(/\s+/g, '-');
    return t('labels.INVALID_LABEL_NAME', { suggestion });
  }
  if (err instanceof LabelNameTooLongError) {
    return t('labels.LABEL_NAME_TOO_LONG', { max: LABEL_NAME_MAX_LENGTH });
  }
  return t('labels.LABEL_LIMIT_EXCEEDED', { limit: LABELS_PER_ISSUE_LIMIT });
}
