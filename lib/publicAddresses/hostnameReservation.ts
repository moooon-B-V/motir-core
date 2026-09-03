import { createHash } from 'node:crypto';

import type { PublicAddressKind } from '@/generated/prisma/client';

// THE §8 RESERVATION — what a hostname leaves behind when its workspace is
// deleted. Bug MOTIR-4366.
//
// `docs/decisions/public-tenant-addresses.md` §8 decides that a subdomain is
// never released. MOTIR-4209 implemented that with the `public_address.hostname`
// unique index alone — "a retired label keeps its row, the row keeps the name" —
// which holds for the case §8 was thinking about (a RENAME, where the workspace
// survives) and does not hold for the case it never asked about (the workspace
// itself going away). `public_address.workspace_id` is `ON DELETE CASCADE`, so a
// workspace delete takes the rows, and with them the reservation.
//
// The delete is not an admin curiosity: `accountErasureSweepService` routes a
// sole-membership workspace through `workspacesService.deleteWorkspace` on a
// scheduled job, discharging a GDPR erasure request. So the release happened
// with nobody deciding it, and the first evidence would have been a stranger's
// roadmap at an address someone's README still points at.
//
// ── WHY A HASH, AND NOT THE HOSTNAME ───────────────────────────────────────
//
// The two obligations meet inside one row and pull opposite ways: §8 wants the
// name held FOR EVER, and Article 17 wants the personal data GONE. A hostname
// can itself be the personal datum — `jane-smith.<base>` — so retaining the
// literal string would be retaining exactly what the erasure was asked to
// remove.
//
// A one-way hash is what separates the two. The reservation never has to be
// READ BACK; it only has to be TESTED against a candidate somebody else
// supplies, which is the single operation §8 needs. So we keep the answer to
// "is this name taken?" and not the name.
//
// ⚠️ NO PEPPER, AND THAT IS A DECISION RATHER THAN AN OMISSION. A keyed hash
// would resist an offline dictionary attack better, and it would also mean the
// entire namespace silently reopens the day the key is lost or rotated — a
// reservation whose whole promise is *for ever* is the wrong place for a
// rotatable secret. The residual is named rather than hidden: someone holding a
// database dump can confirm a hostname they already guessed. That is accepted
// because these hostnames were SERVED ON THE PUBLIC INTERNET by the person who
// chose them; the dump tells an attacker nothing the DNS did not.
//
// The prefix is domain separation, and it is versioned: changing the transform
// means every stored digest stops matching, so a `v2` would have to be a
// migration that re-derives from data this table deliberately does not keep —
// i.e. it is not possible, and the `v1` is there to make that obvious rather
// than to promise an upgrade path.
const RESERVATION_HASH_PREFIX = 'motir:public-hostname-reservation:v1:';

/**
 * The digest a hostname is reserved under.
 *
 * Normalises the way `normaliseCustomHostname` and `tenantBaseDomain` both do —
 * trimmed, lowercased, no trailing dot — so a reservation written from a stored
 * row and a check run against a freshly composed `<label>.<base>` land on the
 * same digest.
 */
export function hostnameReservationHash(hostname: string): string {
  const normalised = hostname.trim().toLowerCase().replace(/\.+$/, '');
  return createHash('sha256').update(`${RESERVATION_HASH_PREFIX}${normalised}`).digest('hex');
}

/**
 * Which address kinds leave a reservation behind — the workspace subdomain and
 * every label it has retired.
 *
 * ⚠️ A `custom_domain` DELIBERATELY DOES NOT, and that is the one judgement in
 * this module. §8's never-released rule is about MOTIR'S OWN namespace: we hand
 * out `<label>.<base>` from a space we own, so releasing a label lets a stranger
 * inherit somebody's inbound links. A customer domain is the CUSTOMER's
 * property — `docs.acme.com` is theirs whatever happens to their Motir account —
 * and reserving it for ever would lock the rightful owner out of connecting
 * their own domain again. Holding a name we do not own is not a protection, it
 * is a hostage.
 */
export function reservesItsHostname(kind: PublicAddressKind): boolean {
  return kind === 'workspace_subdomain' || kind === 'workspace_subdomain_alias';
}
