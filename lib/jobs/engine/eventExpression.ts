// THE ONE EVENT-EXPRESSION RESOLVER (Story MOTIR-3417 · Subtask MOTIR-3483).
//
// Two `defineJob` options carry a template evaluated against the triggering
// event, and Inngest evaluates both server-side as CEL. The Postgres engine has
// to evaluate them itself, and this is where — ONE parser and ONE resolver for
// both, rather than a second one beside the first.
//
//   * `idempotency` — `'event.data.idempotencyKey'` (`emailSend.ts`).
//   * `debounce.key` — `"event.data.installationId + '/' + event.data.repoOwner
//     + '/' + event.data.repoName"` (`codeGraphRefresh.ts`).
//
// MOTIR-3459 built the first as a single `event.data.<field>` match that THREW
// on anything else. The debounce key is a CONCATENATION, so this WIDENS that
// grammar rather than adding a second dialect — the alternative is two resolvers
// that agree today and drift the first time either grows a form.
//
// ===========================================================================
// The grammar, in full
// ===========================================================================
//
//   expression := term ( '+' term )*
//   term       := 'event.data.' IDENT        →  the event payload's field
//                | "'" <no quote> "'"        →  a literal joiner
//
// Whitespace around `+` and around the whole expression is insignificant.
// Nothing else is accepted: no nested paths (`event.data.user.id`), no
// `event.ts`, no function calls, no double-quoted literals.
//
// ⚠️ THE RESOLVER IS TOTAL OVER WHAT IT ACCEPTS, AND THROWS ON THE REST — the
// property MOTIR-3459 established, and it matters MORE for a debounce than for
// an idempotency key.
//
// The tempting shape is to return `null` for an expression this does not
// understand, so an unfamiliar job "just isn't debounced". Inngest's own
// behaviour is worse than that and was MEASURED (MOTIR-2994): an expression that
// does not resolve does not DISABLE the debounce, it MERGES — every such event
// lands in ONE bucket, so N unrelated events produce one run and N−1 vanish with
// nothing raised to the sender. `codeGraphRefresh`'s own header names the
// consequence: unrelated repositories coalesced into one index.
//
// So an unrecognised expression fails LOUDLY, at REGISTRATION, where a
// definition module is evaluated and every process that loads the registry sees
// it. `docs/decisions/job-queue-foundation.md` §9 says the measured limit of
// Inngest's implementation is *"a property of Inngest's implementation that we
// are free not to reproduce"*; this is one of the two places we decline to.
//
// Supporting a richer expression is a deliberate change: extend the grammar and
// its resolver together, and add the case to `tests/jobs/engine-debounce.test.ts`.

/** One resolved piece of an expression. */
export type EventExpressionTerm =
  /** `event.data.<field>` — read from the event payload at dispatch. */
  | { kind: 'field'; field: string }
  /** `'…'` — a constant joiner, contributing the same characters every time. */
  | { kind: 'literal'; value: string };

/** Which option an expression came from — used only to make the throw actionable. */
export type EventExpressionOption = 'idempotency' | 'debounce.key';

const FIELD = /^event\.data\.([A-Za-z_$][A-Za-z0-9_$]*)$/;
const LITERAL = /^'([^']*)'$/;

function unsupported(
  jobId: string,
  option: EventExpressionOption,
  expression: string,
  offendingTerm?: string,
): Error {
  // The tail differs per option because the SILENT failure differs: an
  // idempotency template that stops resolving stops deduplicating (a second
  // password-reset email), and a debounce key that stops resolving MERGES
  // (unrelated repositories indexed as one). Neither is a reason to drop the
  // option, and saying which one is at stake is what makes the message act on.
  const consequence =
    option === 'idempotency'
      ? 'a job that keeps the option and stops deduplicating fails silently'
      : 'a job that keeps the option and stops coalescing MERGES unrelated events into one bucket';
  return new Error(
    `Job "${jobId}" declares ${option}: ${JSON.stringify(expression)}, which the Postgres ` +
      `job engine cannot evaluate` +
      (offendingTerm === undefined ? '' : ` (the term ${JSON.stringify(offendingTerm)})`) +
      `. The supported form is a "+"-joined sequence of "event.data.<field>" terms and ` +
      `single-quoted literals — e.g. "event.data.a + '/' + event.data.b". ` +
      `Extend lib/jobs/engine/eventExpression.ts to support this expression — do NOT drop the ` +
      `option, because ${consequence}.`,
  );
}

/**
 * Parse ONE expression at REGISTRATION time, into the terms the dispatcher will
 * resolve per event.
 *
 * Called from `defineJob`, so a job declaring an expression the engine cannot
 * evaluate fails as its module is evaluated rather than silently losing the
 * behaviour at dispatch.
 */
export function parseEventExpression(
  jobId: string,
  option: EventExpressionOption,
  expression: string,
): EventExpressionTerm[] {
  const trimmed = expression.trim();
  if (trimmed.length === 0) throw unsupported(jobId, option, expression);

  // Splitting on `+` is safe ONLY because a literal cannot contain one that
  // matters: `LITERAL` forbids an embedded quote, so a `+` inside a literal is
  // still a `+` between two quotes and would produce an unparseable term rather
  // than a silently wrong split. A literal that genuinely needs a `+` is a
  // grammar extension, not something to guess at.
  const terms: EventExpressionTerm[] = [];
  for (const raw of trimmed.split('+')) {
    const piece = raw.trim();
    const field = FIELD.exec(piece);
    if (field) {
      terms.push({ kind: 'field', field: field[1]! });
      continue;
    }
    const literal = LITERAL.exec(piece);
    if (literal) {
      terms.push({ kind: 'literal', value: literal[1]! });
      continue;
    }
    throw unsupported(jobId, option, expression, piece);
  }
  return terms;
}

/**
 * Resolve parsed terms against ONE event payload.
 *
 * ⚠️ A MISSING OR NON-STRING FIELD YIELDS `null`, WHICH MEANS "NO KEY" — and for
 * both options "no key" means *this event gets its own row*: not deduped, not
 * coalesced. That is the safe direction in both, and it is the opposite of what
 * Inngest does with an unresolvable debounce key (it merges).
 *
 * It is not a silent arm, because the EXPRESSION was already validated at
 * registration: reaching here with no value means the EVENT did not carry one,
 * never that the job was misconfigured. Substituting a placeholder would be far
 * worse — every event missing the field would collide with every other one, and
 * all but one would be dropped.
 *
 * A literal-only expression therefore always resolves; it is accepted by the
 * grammar and is a job's own decision to make.
 */
export function resolveEventExpression(
  terms: ReadonlyArray<EventExpressionTerm>,
  data: unknown,
): string | null {
  const payload = (data ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const term of terms) {
    if (term.kind === 'literal') {
      parts.push(term.value);
      continue;
    }
    const value = payload[term.field];
    if (typeof value !== 'string' || value.length === 0) return null;
    parts.push(value);
  }
  const key = parts.join('');
  return key.length > 0 ? key : null;
}
