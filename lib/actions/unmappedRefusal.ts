import * as Sentry from '@sentry/nextjs';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import {
  SERVER_ACTION_CONTEXT,
  findExpectedDomainError,
} from '@/lib/monitoring/expectedDomainErrors';

// The last arm of a Server Action's catch (MOTIR-6147).
//
// An action maps the typed refusals it knows about into its own result shape
// and rethrows everything else. A rethrow from a Server Action is a 500: the
// browser renders the generic "error occurred in the Server Components render"
// and the person's change is silently lost. That is right for a FAULT, and
// wrong for a typed refusal the action merely did not anticipate — the service
// refused on purpose (a 4xx everywhere else in the product) and the person
// deserves to read why, in place.
//
// So before an action rethrows, it asks here. A typed domain 4xx — the same
// vocabulary `classifyApiV1Error` answers the REST API with — becomes a message
// the action returns; anything else is still rethrown, because a fault is
// still a fault.
//
// ⚠️ AND IT IS STILL REPORTED. Converting a refusal to a result would otherwise
// make it invisible twice over: no throw for `onRequestError` to see, and a
// 4xx that `dropExpectedDomainErrors` drops. An unmapped refusal is a missing
// mapping in the action — something to fix — so it goes to Sentry at `warning`,
// carrying the `server_action` context that filter always keeps, with the
// action's name and the refusal's code.

/**
 * If `err` is a typed domain refusal (a 4xx in the API's vocabulary), report
 * it as an unmapped refusal of `action` and return its code and message.
 * Returns null for anything else — the caller rethrows that.
 */
export function reportUnmappedActionRefusal(
  err: unknown,
  action: string,
): { code: string; message: string } | null {
  const refusal = findExpectedDomainError(err);
  if (!refusal) return null;
  Sentry.withScope((scope) => {
    scope.setLevel('warning');
    scope.setTag('unmapped_action_refusal', refusal.code);
    scope.setContext(SERVER_ACTION_CONTEXT, { action, code: refusal.code });
    Sentry.captureException(err);
  });
  return refusal;
}

/**
 * The in-place message for a typed domain refusal an action did not map, or
 * null when `err` is not one (rethrow it). Reports the refusal either way —
 * see {@link reportUnmappedActionRefusal}.
 */
export async function unmappedActionRefusalMessage(
  err: unknown,
  action: string,
): Promise<string | null> {
  const refusal = reportUnmappedActionRefusal(err, action);
  if (!refusal) return null;
  const t = await getErrorsTranslator();
  return t('actions.refused', { reason: refusal.message });
}
