/**
 * The SQLSTATE a Postgres failure carries — wherever the client of the day puts it.
 *
 * ── Why this is a function and not a property read (MOTIR-5687) ──────────────
 * A trigger refusal or an RLS denial reaches us through `@prisma/adapter-pg`,
 * and the shape it arrives in has MOVED between client versions:
 *
 *   prisma <= 7.8.0   err.cause.code                                 '42501'
 *   prisma >= 7.9.0   err.code                                       'P2039'
 *                     err.meta.driverAdapterError.cause.code         '42501'
 *
 * Both were already live in this tree before the move: `tests/last-active-project.test.ts`
 * asserted the nested form while sixteen other suites asserted the flat one, because
 * which one you got depended on the call path. 7.10 makes the nesting uniform.
 *
 * This mattered rather than being cosmetic: three repositories each carried their
 * OWN copy of this extractor, reading `err.cause` only, so the upgrade silently
 * retired the SQLSTATE arm of every one of them at once. Two survived on a message
 * marker (`AG_DECIDED_IMMUTABLE`, `WI_LINK_*`) and kept throwing the right typed
 * error, which is the only reason this was a red test rather than a wrong answer in
 * production. `tests/approval-gate-coverage-floor.test.ts` had predicted exactly
 * this moment in its own words — *"until the driver upgrade the sentence was written
 * for arrives and the refusal stops being typed"*.
 *
 * ⚠️ SO IT READS BOTH SHAPES, AND IT IS THE ONLY PLACE THAT DOES. A fourth copy
 * appearing in a repository is the defect this file exists to prevent; the tests
 * assert through THIS function, so a future client move breaks one place and the
 * RLS suites go red for the right reason.
 *
 * The `originalCode` fallback is kept from the implementations this replaces: no
 * shipped adapter reaches it, and it is what a differently-shaped future driver
 * would expose.
 */
export function sqlStateOf(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;

  // The flat shape: prisma <= 7.8, and what a hand-built error in a unit test
  // carries — `Object.assign(new Error(…), { cause: { code: '23514' } })`.
  const direct = codeOfCause((err as { cause?: unknown }).cause);
  if (direct !== undefined) return direct;

  // The nested shape: prisma >= 7.9 wraps the driver's error under `meta`.
  const meta = (err as { meta?: unknown }).meta;
  if (meta && typeof meta === 'object') {
    const adapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
    if (adapterError && typeof adapterError === 'object') {
      return codeOfCause((adapterError as { cause?: unknown }).cause);
    }
  }

  return undefined;
}

function codeOfCause(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object') return undefined;
  const c = cause as { code?: unknown; originalCode?: unknown };
  if (typeof c.code === 'string') return c.code;
  if (typeof c.originalCode === 'string') return c.originalCode;
  return undefined;
}
