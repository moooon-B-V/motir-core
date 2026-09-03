// Typed errors for the public-address data layer — Story MOTIR-3878 · Subtask
// MOTIR-4209. The service and route layers above map each `code` to an HTTP
// status; nothing here knows about HTTP.
//
// This file exists at the REPOSITORY tier, which is unusual and deliberate: the
// hostname race is arbitrated by a database constraint, so the only place that
// can recognise it is the layer holding the Prisma call. Letting a raw `P2002`
// escape would make every caller re-implement the same string match against a
// Prisma error code — which is precisely the shape `CLAUDE.md`'s concurrency
// rule forbids ("translate raw DB races to typed errors ... so a raw DB error
// never escapes the service").

import type { LabelRefusal } from '@/lib/publicAddresses/reservedNames';

/**
 * Somebody else already holds this hostname.
 *
 * The `hostname` unique index is GLOBAL, so this is raised for three different
 * situations that are one situation to the database, and the caller must not
 * assume which:
 *
 *   1. another workspace has claimed the label;
 *   2. another project has connected the domain;
 *   3. **a RETIRED alias still holds the name** — the ADR §8 never-released
 *      rule, which is the case a customer will not expect and the one the
 *      settings copy is written to explain.
 *
 * The three are deliberately NOT distinguished. Telling a claimer *which*
 * workspace holds a name, or that it is held by a workspace that no longer uses
 * it, is an existence leak across the tenancy boundary for no gain — the answer
 * they need is the same in all three cases: pick another name.
 *
 * The `IdentifierTakenError` precedent (`projectsService.changeKey`) is the same
 * shape one level down.
 */
export class HostnameTakenError extends Error {
  readonly code = 'HOSTNAME_TAKEN' as const;
  constructor(readonly hostname: string) {
    super(`The hostname ${hostname} is already in use.`);
    this.name = 'HostnameTakenError';
  }
}

/**
 * The requested subdomain label is refused by the ADR §8 grammar or reserved
 * set. Carries the discriminator so the surface can say WHICH rule refused it —
 * "reserved" and "too short" send a customer to different next actions.
 */
export class ReservedLabelError extends Error {
  readonly code = 'RESERVED_LABEL' as const;
  constructor(
    readonly label: string,
    readonly refusal: LabelRefusal,
  ) {
    super(`The subdomain ${label} is not available (${refusal}).`);
    this.name = 'ReservedLabelError';
  }
}

/**
 * Prisma's unique-constraint violation code. Named rather than inlined so the
 * one place that recognises it is greppable.
 */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Is this thrown error a unique-constraint violation on `public_address.hostname`?
 *
 * ⚠️ It checks the TARGET, not just the code. A `P2002` from this table could
 * only be the hostname index today — it is the only unique constraint on it —
 * but "today" is exactly the assumption that rots: adding a second unique index
 * later would silently start reporting its violations as HostnameTakenError, and
 * the customer would be told to pick another hostname for a collision that had
 * nothing to do with one. Reading the target costs one comparison and cannot
 * age.
 *
 * The shape Prisma reports is not part of its public typings, so this narrows
 * structurally rather than casting to `Prisma.PrismaClientKnownRequestError` —
 * which also keeps this module importable without a Prisma runtime.
 */
export function isHostnameUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code !== PRISMA_UNIQUE_VIOLATION) return false;
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) return target.includes('hostname');
  if (typeof target === 'string') return target.includes('hostname');
  // A P2002 from this table with no readable target: treat it as the hostname
  // race rather than letting a raw Prisma error escape. The narrower reading
  // would be to rethrow, but that trades a correct-in-every-observed-case answer
  // for a raw error crossing the service boundary, which is the thing the rule
  // is about.
  return true;
}
