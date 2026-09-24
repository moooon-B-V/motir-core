import type { ErrorEvent, EventHint } from '@sentry/nextjs';
import { classifyApiV1Error } from '@/lib/api/v1/errors';

// The signal filter for SERVER and EDGE events (Subtask 8.5.6 / MOTIR-1162).
//
// A typed domain error is not a fault. `WORK_ITEM_NOT_FOUND`, `NOT_A_MEMBER`,
// `RATE_LIMITED`, a validation refusal — every one of them is the product
// working: the route layer catches it and answers a documented 4xx. Reporting
// those as errors does not merely add noise, it INVERTS the alert: MOTIR-1161
// deliberately widened Sentry's new-issue rule from high-priority-only to ALL
// new issues, on the argument that at near-zero traffic letting a heuristic
// decide what you hear about is how the first real bug goes unseen. That
// argument only survives if the things arriving are actually bugs.
//
// ⚠️ THE DISCRIMINATOR IS THE SHIPPED MAP, NOT A SHAPE TEST. The tempting
// filter is "an object with a SCREAMING_SNAKE `code` and a name ending in
// Error" — which is a guess, and one that would silently start dropping real
// faults the day some library adopts the same shape (`code: 'ECONNREFUSED'` is
// already that shape). `classifyApiV1Error` is the function the `/api/v1`
// wrapper itself uses to decide a thrown value's status, over
// `DOMAIN_ERROR_STATUS` — the closed, reviewed vocabulary in
// `lib/api/v1/errors.ts`. Asking it is asking the product what it considers
// expected, so the two cannot disagree.
//
// ⚠️ AND IT IS 4xx SPECIFICALLY, NOT "anything the map knows". That map also
// carries 503 rows (`AI_UNAVAILABLE` and friends) — a dependency being down IS
// something to be paged about, and a filter written as "in the map ⇒ drop"
// would have taken exactly those out.
//
// This is a BACKSTOP rather than the primary mechanism: a domain error that the
// route caught never reaches Sentry at all, because Sentry only sees what Next
// treats as unhandled. It earns its place on the paths where one escapes — a
// Server Action, a route that rethrows an unmapped code, a service called
// outside a wrapper — which are precisely the paths nobody enumerated.
//
// ⚠️ EXCEPT A SERVER ACTION (MOTIR-6147). A route handler answers a caught
// domain error with its 4xx, so dropping one that also reached Sentry costs
// nothing. A Server Action has no such translation: whatever it throws, the
// browser receives a 500 and renders the generic "error occurred in the Server
// Components render". An escaped typed refusal there IS the fault — an
// unmapped refusal the user met as a crash — and dropping it hid every one:
// 705 server events in 90 days, zero from any action, while two item-page
// actions and one approval-overlay action were 500ing in production. So an
// event that escaped a Server Action is always kept, whatever its error.

/** The status range that means "the product refused, on purpose". */
function isClientError(status: number): boolean {
  return status >= 400 && status < 500;
}

/**
 * The typed domain error in `err`'s `cause` chain that the API answers with a
 * 4xx — its code and message — or null when there is none.
 *
 * Walks the `cause` chain: a domain error re-thrown inside a wrapper arrives
 * as the cause of something generic, and a one-level check would report it.
 */
export function findExpectedDomainError(err: unknown): { code: string; message: string } | null {
  let current = err;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    const classified = classifyApiV1Error(current);
    if (classified && isClientError(classified.status)) {
      return { code: classified.body.code, message: classified.body.error };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** True when `err` is a typed domain error the API answers with a 4xx. */
export function isExpectedDomainError(err: unknown): boolean {
  return findExpectedDomainError(err) !== null;
}

/** The Sentry context an action's refusal helper stamps on the event it
 *  reports for a refusal it converted rather than rethrew (MOTIR-6147). */
export const SERVER_ACTION_CONTEXT = 'server_action';

/**
 * True when the event came out of a Server Action. Two sources: Next's
 * `onRequestError` reports an action's throw with `routeType: 'action'`, which
 * `captureRequestError` records as `contexts.nextjs.route_type`; and
 * `reportUnmappedActionRefusal` stamps {@link SERVER_ACTION_CONTEXT} on the
 * refusal it converts to a result.
 */
function escapedServerAction(event: ErrorEvent): boolean {
  const contexts = event.contexts as
    | Record<string, Record<string, unknown> | undefined>
    | undefined;
  return (
    contexts?.['nextjs']?.['route_type'] === 'action' || contexts?.[SERVER_ACTION_CONTEXT] != null
  );
}

/**
 * A Sentry `beforeSend` that drops expected typed domain 4xx and passes
 * everything else through untouched — and never drops an event that escaped a
 * Server Action, where no 4xx was ever sent.
 *
 * Returning `null` drops the event; returning the event sends it. Nothing is
 * mutated — a filter that also edited events would make "why is this field
 * missing?" a question about this file.
 */
export function dropExpectedDomainErrors(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  if (escapedServerAction(event)) return event;
  return isExpectedDomainError(hint.originalException) ? null : event;
}
