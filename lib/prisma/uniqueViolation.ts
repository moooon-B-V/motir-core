/** Prisma's error code for a unique-constraint violation. */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * WHICH unique constraint a `P2002` violated — wherever the client of the day puts it.
 *
 * ── Why this is one function and not a property read (MOTIR-5273) ─────────────
 * The obvious read is `err.meta.target`, and under this client it is ABSENT for
 * every table measured so far (`project_repository`, `public_address`,
 * `monitor_connection`). Two facts combine, and both were MEASURED rather than
 * deduced (MOTIR-4833):
 *
 *   1. `@prisma/adapter-pg` derives `meta.target` from the error's `DETAIL` line
 *      ALONE (`error.detail?.match(/Key \(([^)]+)\)/)`), never from the
 *      `constraint` field PostgreSQL also sends.
 *   2. Under FORCE ROW LEVEL SECURITY and a non-superuser role, PostgreSQL declines
 *      to describe the conflicting key, so the `23505` carries NO `DETAIL` at all.
 *
 * No `DETAIL` ⇒ no `target`. The constraint name is not lost, though — Prisma
 * keeps the driver's own error under `meta.driverAdapterError`, and its
 * `originalMessage` quotes the constraint:
 *
 *   meta = { modelName, driverAdapterError: { cause: {
 *     originalCode: '23505',
 *     originalMessage: 'duplicate key value violates unique constraint "<name>"' } } }
 *
 * ⚠️ SO IT READS BOTH, AND IT IS THE ONLY PLACE THAT DOES. MOTIR-4833 fixed this
 * in ONE service while a byte-for-byte equivalent translator one file over kept
 * reading `meta.target` alone — a fix swept to a call site when the defect was a
 * class. Every classifier of a `P2002` asks this function which constraint fired;
 * a new hand-written reader of `meta.target` is the defect this file exists to
 * prevent, the same way `sqlstate.ts` is for the SQLSTATE.
 *
 * It narrows STRUCTURALLY rather than on `Prisma.PrismaClientKnownRequestError`,
 * so a module that must stay importable without a Prisma runtime can use it.
 *
 * Returns the names in the order they are most reliable — the structured
 * `meta.target` (a column list, or the index name) when Prisma has one, else the
 * constraint quoted in the driver's message — or `null` when the error is not a
 * `P2002` or neither layer names a constraint. **`null` is an answer of its own**,
 * never a licence to guess: the caller decides what an unclassifiable violation
 * means, and the answer it owes is a typed error, not a raw re-throw.
 */
export function uniqueViolationConstraints(err: unknown): string[] | null {
  if (typeof err !== 'object' || err === null) return null;
  if ((err as { code?: unknown }).code !== PRISMA_UNIQUE_VIOLATION) return null;
  const meta = (err as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return null;

  const target = (meta as { target?: unknown }).target;
  if (Array.isArray(target)) {
    const fields = target.map(String).filter((f) => f.length > 0);
    if (fields.length > 0) return fields;
  } else if (typeof target === 'string' && target.length > 0) {
    return [target];
  }

  const quoted = quotedConstraint(meta);
  return quoted === null ? null : [quoted];
}

/**
 * The constraint name out of the driver's own message. Only the QUOTED identifier
 * is taken: the message is server-localized, so an `lc_messages` other than
 * English changes the prose around the name and not the name itself.
 */
function quotedConstraint(meta: object): string | null {
  const adapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof adapterError !== 'object' || adapterError === null) return null;
  const cause = (adapterError as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return null;
  const message = (cause as { originalMessage?: unknown }).originalMessage;
  if (typeof message !== 'string') return null;
  return message.match(/"([^"]+)"/)?.[1] ?? null;
}
