// EVENT-LEVEL IDEMPOTENCY, RESOLVED (Story MOTIR-3415 · Subtask MOTIR-3459).
//
// `defineJob`'s `idempotency` option is an Inngest CEL template evaluated against
// the triggering event — `'event.data.idempotencyKey'` is the only form in the
// tree, declared by `lib/jobs/definitions/emailSend.ts`, which is the only job
// that declares one at all. Inngest evaluates it server-side; the Postgres engine
// has to evaluate it itself, and this is where.
//
// ⚠️ THE RESOLVER IS TOTAL OVER WHAT IT ACCEPTS, AND THROWS ON THE REST.
//
// The tempting shape is to return `null` for a template this does not
// understand, so an unfamiliar job "just isn't deduped". That is the silent arm:
// a future job declaring `'event.data.user.id'` or `'event.ts'` would keep its
// `idempotency` option, keep passing review, and quietly stop deduplicating — and
// the symptom is a second password-reset email to a real person, on the retry
// path nobody exercises by hand. A lookup keyed off a value must be total over
// what that value can hold, so an unrecognised template fails LOUDLY, at
// REGISTRATION, where a definition module is evaluated and every process that
// loads the registry will see it.
//
// Supporting a richer template is a deliberate change: extend `TEMPLATE` and its
// resolver together, and add the case to
// `tests/jobs/engine-idempotency.test.ts`.

/** The one template form in use: `event.data.<field>`, one level deep. */
const TEMPLATE = /^event\.data\.([A-Za-z_$][A-Za-z0-9_$]*)$/;

/**
 * Validate an `idempotency` template at REGISTRATION time.
 *
 * Called from `defineJob`, so a job declaring a template the engine cannot
 * evaluate fails as its module is evaluated rather than silently losing its
 * dedup at dispatch. Returns the field name the template selects.
 */
export function parseIdempotencyTemplate(jobId: string, template: string): string {
  const match = TEMPLATE.exec(template.trim());
  if (match === null) {
    throw new Error(
      `Job "${jobId}" declares idempotency: ${JSON.stringify(template)}, which the Postgres ` +
        `job engine cannot evaluate. The supported form is "event.data.<field>". ` +
        `Extend lib/jobs/engine/idempotency.ts to support this template — do NOT drop the ` +
        `option, because a job that keeps it and stops deduplicating fails silently.`,
    );
  }
  return match[1]!;
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
  const payload = (data ?? {}) as Record<string, unknown>;
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
