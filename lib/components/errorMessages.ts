import {
  ComponentNameConflictError,
  ComponentNotFoundError,
  CrossProjectComponentError,
  InvalidComponentNameError,
  InvalidDefaultAssigneeError,
  InvalidMoveTargetError,
} from '@/lib/components/errors';
import { NotProjectAdminError } from '@/lib/projects/errors';

// A minimal translator shape — satisfied by next-intl's `getTranslations('errors')`
// result — so this pure mapper stays free of any next-intl import / request
// access (the workItemErrorMessage seam).
type ErrorTranslator = (key: string, values?: Record<string, string | number>) => string;

/** The component-domain error union the UI surfaces translate. */
export type ComponentError =
  | ComponentNotFoundError
  | InvalidComponentNameError
  | ComponentNameConflictError
  | InvalidDefaultAssigneeError
  | InvalidMoveTargetError
  | CrossProjectComponentError
  | NotProjectAdminError;

export function isComponentError(err: unknown): err is ComponentError {
  return (
    err instanceof ComponentNotFoundError ||
    err instanceof InvalidComponentNameError ||
    err instanceof ComponentNameConflictError ||
    err instanceof InvalidDefaultAssigneeError ||
    err instanceof InvalidMoveTargetError ||
    err instanceof CrossProjectComponentError ||
    err instanceof NotProjectAdminError
  );
}

/**
 * Maps a typed component error to its translated, user-facing message
 * (`errors.components.<CODE>`). TOTAL over the domain's codes (mistake #29 —
 * no partial-function holes): the rail picker surfaces the not-found /
 * cross-project pair; the 5.4.10 admin page reuses the CRUD half.
 */
export function componentErrorMessage(err: ComponentError, t: ErrorTranslator): string {
  return t(`components.${err.code}`);
}
