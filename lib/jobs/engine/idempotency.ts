import {
  parseEventExpression,
  resolveEventExpression,
  type EventExpressionTerm,
} from './eventExpression';

// EVENT-LEVEL IDEMPOTENCY, RESOLVED (Story MOTIR-3415 · Subtask MOTIR-3459).
//
// `defineJob`'s `idempotency` option is an Inngest CEL template evaluated against
// the triggering event — `'event.data.idempotencyKey'` is the only form in the
// tree, declared by `lib/jobs/definitions/emailSend.ts`, which is the only job
// that declares one at all. Inngest evaluates it server-side; the Postgres engine
// has to evaluate it itself, and this is the door onto the resolver that does.
//
// ⚠️ THE GRAMMAR AND THE TOTALITY MOVED, THE CONTRACT DID NOT (MOTIR-3483).
// This file used to carry its own single-`event.data.<field>` regex. The debounce
// key is a CONCATENATION of the same terms, so the parser and the resolver now
// live in `./eventExpression.ts` and serve BOTH options — one dialect that cannot
// drift, rather than two that agree until either grows a form. Everything the old
// header argued for is unchanged and is argued there: an expression the engine
// cannot evaluate throws at REGISTRATION rather than degrading to "not deduped",
// because the symptom of the silent arm is a second password-reset email to a
// real person on the retry path nobody exercises by hand.
//
// What stays HERE is the one thing that is specific to this option: what a
// resolved key is USED for, and what its absence means.

/**
 * Validate an `idempotency` template at REGISTRATION time, and return the field
 * it selects.
 *
 * ⚠️ THE IDEMPOTENCY DOOR IS DELIBERATELY NARROWER THAN THE GRAMMAR — one field
 * term, no literals, no concatenation. The grammar accepts more because the
 * debounce key needs more; a dedup key does not, and the two narrowings it
 * enforces are both worth having. A literal-only key would collide EVERY event
 * of the job into one row (the exact failure the resolver's `null` arm exists to
 * avoid), and a composed dedup key has no consumer in the tree, so accepting one
 * would be a shape nothing tests. Widening this is a deliberate change with a
 * caller behind it.
 */
export function parseIdempotencyTemplate(jobId: string, template: string): string {
  const terms = parseEventExpression(jobId, 'idempotency', template);
  const only = terms.length === 1 ? terms[0] : undefined;
  if (only === undefined || only.kind !== 'field') {
    throw new Error(
      `Job "${jobId}" declares idempotency: ${JSON.stringify(template)}, which the Postgres ` +
        `job engine cannot evaluate as a dedup key. The supported form is exactly one ` +
        `"event.data.<field>" term — a composed key has no consumer in this tree and a ` +
        `literal-only one would collide every event of this job into a single run.`,
    );
  }
  return only.field;
}

/**
 * The dedup key for one event, or `null` when the job declares no `idempotency`
 * or the payload carries no usable value.
 *
 * ⚠️ A MISSING OR NON-STRING VALUE YIELDS `null`, WHICH MEANS "DO NOT DEDUPE" —
 * and that is correct rather than a silent arm, because the partial unique index
 * excludes NULLs. The template has already been validated at registration, so
 * reaching here with no value means the EVENT did not carry one, not that the
 * job was misconfigured. Deduping on a synthesised placeholder would be far
 * worse: every event missing the field would collide with every other one and
 * all but the first would be dropped.
 */
export function resolveIdempotencyKey(
  template: string | undefined,
  data: unknown,
  jobId: string,
): string | null {
  if (template === undefined) return null;
  const field = parseIdempotencyTemplate(jobId, template);
  const terms: EventExpressionTerm[] = [{ kind: 'field', field }];
  return resolveEventExpression(terms, data);
}
