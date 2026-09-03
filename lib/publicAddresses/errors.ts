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

// ── The SERVICE tier's errors (MOTIR-4215) ─────────────────────────────────
//
// The route layer maps each `code` to a status. They are separate types rather
// than one error with a discriminator because the route's mapper is a series of
// `instanceof` branches, and a single type would make every branch a nested
// switch on a field.

/** A rename was asked for on a workspace that has never claimed a subdomain. */
export class NoSubdomainClaimedError extends Error {
  readonly code = 'NO_SUBDOMAIN_CLAIMED' as const;
  constructor() {
    super('This workspace has not claimed a subdomain yet.');
    this.name = 'NoSubdomainClaimedError';
  }
}

/**
 * The workspace has renamed its subdomain as many times as the ADR §8 cap
 * allows.
 *
 * The cap exists because every rename permanently burns a name in a shared
 * namespace — a retired label is never released — so it is a namespace
 * protection rather than a UX limit, and the error says how many were used.
 */
export class SubdomainRenameCapReachedError extends Error {
  readonly code = 'SUBDOMAIN_RENAME_CAP_REACHED' as const;
  constructor(
    readonly used: number,
    readonly cap: number,
  ) {
    super(`This workspace has used all ${cap} subdomain renames.`);
    this.name = 'SubdomainRenameCapReachedError';
  }
}

/**
 * The actor may see the workspace but may not change its address.
 *
 * DISTINCT from "not a member", which answers 404: a member can see that the
 * workspace exists, so telling them the address is admin-only leaks nothing and
 * is the answer they need. A non-member gets the no-existence-leak 404 the rest
 * of the tenancy boundary gives.
 */
export class SubdomainForbiddenError extends Error {
  readonly code = 'SUBDOMAIN_FORBIDDEN' as const;
  constructor() {
    super('Only a workspace owner or admin can change the public address.');
    this.name = 'SubdomainForbiddenError';
  }
}

/** The actor is not a member of this workspace — answered as a 404. */
export class WorkspaceNotVisibleError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor() {
    super('Not found.');
    this.name = 'WorkspaceNotVisibleError';
  }
}

/**
 * Public addresses are a CLOUD capability (ADR §11).
 *
 * ABSENT, not hidden — the same posture `lib/publicProjects/cloudGate.ts` takes
 * and for the same reason: a 403 says *this exists and you may not see it*,
 * which is a false statement about a self-hosted build. There is no door.
 */
export class PublicAddressesUnavailableError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor() {
    super('Not found.');
    this.name = 'PublicAddressesUnavailableError';
  }
}

// ── The CUSTOMER-DOMAIN lifecycle's errors (MOTIR-4216) ────────────────────

/** The hostname is not a hostname, or carries a scheme / port / path. */
export class InvalidHostnameError extends Error {
  readonly code = 'INVALID_HOSTNAME' as const;
  constructor(readonly hostname: string) {
    super(`${hostname} is not a valid hostname.`);
    this.name = 'InvalidHostnameError';
  }
}

/**
 * The hostname is one WE serve — the tenant base domain, anything under it, or
 * `motir.co` and its subdomains.
 *
 * Refused rather than allowed-and-ignored: a customer who "connects"
 * `acme.motir.site` would be adding a row for an address the wildcard already
 * serves, and the certificate request for it would either collide with the
 * wildcard or sit pending for ever. The refusal has its own code so the pane can
 * say *you already have this address* instead of *that name is taken*.
 */
export class NotACustomerDomainError extends Error {
  readonly code = 'NOT_A_CUSTOMER_DOMAIN' as const;
  constructor(readonly hostname: string) {
    super(`${hostname} is a Motir address, not a domain you own.`);
    this.name = 'NotACustomerDomainError';
  }
}

/** An operation legal only on an `issued` address was asked of another status. */
export class AddressNotIssuedError extends Error {
  readonly code = 'ADDRESS_NOT_ISSUED' as const;
  constructor(readonly status: string) {
    super(`This address is ${status}; only a live address can be made primary.`);
    this.name = 'AddressNotIssuedError';
  }
}

/** The address id does not name a row in this project. */
export class AddressNotFoundError extends Error {
  readonly code = 'ADDRESS_NOT_FOUND' as const;
  constructor() {
    super('Not found.');
    this.name = 'AddressNotFoundError';
  }
}
