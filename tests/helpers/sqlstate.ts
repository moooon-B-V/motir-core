import { sqlStateOf } from '@/lib/prisma/sqlstate';

// ASSERTING A POSTGRES REFUSAL, THROUGH THE PRODUCT'S OWN EXTRACTOR (MOTIR-5687).
//
// These suites used to match the error's SHAPE —
// `.rejects.toMatchObject({ cause: { code: '42501' } })` — and the shape moved
// under them when the Prisma client went 7.8.0 -> 7.9.0 (the version this repository
// pins; the move was measured against 7.10.0 first, which is why an earlier draft of
// this comment named it):
//
//   prisma <= 7.8.0   err.cause.code                            '42501'
//   prisma >= 7.9.0   err.meta.driverAdapterError.cause.code    '42501'
//
// Nineteen sites asserted the flat form and six already asserted the nested one,
// because which you got depended on the call path — so the suite was pinning an
// accident rather than a claim, and half of it went red on an upgrade that broke
// nothing. What these tests actually mean is *"Postgres refused this write with
// SQLSTATE 42501"*, which is true in both shapes and in whatever the next client
// version does.
//
// ⚠️ THE PREDICATE READS THROUGH `sqlStateOf`, THE SAME FUNCTION THE REPOSITORIES
// USE, and that is the point rather than convenience. Three repositories each had
// their own copy of that extractor and the upgrade retired the SQLSTATE arm of all
// three at once, silently — two only kept working because they also match a
// message marker. Asserting through the product's extractor means a future client
// move breaks ONE place, and these suites go red for the right reason: not "the
// error looks different" but "the product can no longer tell an RLS denial from
// anything else".

/** Does this rejection carry `sqlState`, wherever the client nested it? */
export const isSqlState =
  (sqlState: string) =>
  (err: unknown): boolean =>
    sqlStateOf(err) === sqlState;

/** SQLSTATE 42501, `insufficient_privilege` — the row-level-security denial. */
export const isRlsDenial = isSqlState('42501');

/** The message `toSatisfy` prints when a write that had to be refused was not. */
export const RLS_DENIAL = 'the row-level security policy must refuse this write (SQLSTATE 42501)';

/** SQLSTATE 23514, `check_violation` — how every `WI_*` / `AG_*` trigger refuses. */
export const isCheckViolation = isSqlState('23514');

/** The message `toSatisfy` prints when a write a trigger had to refuse was not. */
export const CHECK_VIOLATION = 'a trigger must refuse this write (SQLSTATE 23514)';

/**
 * A trigger refusal identified by BOTH halves of what it is: the SQLSTATE, and
 * the marker the trigger raises (`WI_LINK_CROSS_WORKSPACE`, `WI_PARENT_CYCLE`, …).
 *
 * The marker is read from the top-level message, which is where every client
 * version has put it — 7.9+ embeds the driver's text in the message it composes
 * (`Database error. Code: '23514'. Message: '…WI_PARENT_CYCLE…'`), and the nested
 * arms below cover a driver that reports it only underneath. Keying on both halves
 * is deliberate: the SQLSTATE alone cannot tell two triggers on one table apart,
 * and the marker alone would pass for a plain string appearing in some other error.
 */
export const isTriggerRefusal =
  (marker: string, sqlState = '23514') =>
  (err: unknown): boolean =>
    isSqlState(sqlState)(err) && pgMessageOf(err).includes(marker);

/** Every message a Postgres failure carries, top-level and nested, concatenated. */
function pgMessageOf(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const parts: string[] = [];
  const top = (err as { message?: unknown }).message;
  if (typeof top === 'string') parts.push(top);
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const m = (cause as { message?: unknown }).message;
    if (typeof m === 'string') parts.push(m);
  }
  const meta = (err as { meta?: unknown }).meta;
  if (meta && typeof meta === 'object') {
    const adapter = (meta as { driverAdapterError?: unknown }).driverAdapterError;
    if (adapter && typeof adapter === 'object') {
      const m = (adapter as { message?: unknown }).message;
      if (typeof m === 'string') parts.push(m);
      const c = (adapter as { cause?: unknown }).cause;
      if (c && typeof c === 'object') {
        const cm = (c as { message?: unknown; originalMessage?: unknown }).message;
        if (typeof cm === 'string') parts.push(cm);
        const om = (c as { originalMessage?: unknown }).originalMessage;
        if (typeof om === 'string') parts.push(om);
      }
    }
  }
  return parts.join('\n');
}
