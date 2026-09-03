import type { DnsInstructionDto } from '@/lib/dto/publicAddresses';

// THE RECORDS THAT POINT A CUSTOMER HOSTNAME AT US — Story MOTIR-3878 · MOTIR-4278.
//
// `docs/decisions/public-tenant-addresses.md` §5's table decides the SET, per
// hostname shape, and §10 names the variables the values come from:
//
//   a subdomain (`roadmap.acme.com`)  →  CNAME  → the app's hostname
//   an apex     (`acme-roadmap.com`)  →  A + AAAA → the app's dedicated addresses
//
// ⚠️ THIS IS CONFIGURATION, NOT A PROVIDER READING, AND THAT IS THE ADR'S ORDER
// RATHER THAN A SHORTCUT. §5's order of operations has the customer create the
// pointing record AND the ownership `TXT` at step 2 — before *Verify*, and
// therefore before a certificate is ever requested. The provider only reports
// `dns_requirements` once a certificate HAS been requested, so a reading cannot
// exist at the one moment the customer needs the record. `toDto` is synchronous
// over a database row for the same reason: there is nothing to await.
//
// ⚠️ AND IT IS DELIBERATELY PROVIDER-AGNOSTIC. Deriving the CNAME target from
// `FLY_CERTS_APP` as `${app}.fly.dev` would work today and would weld Fly
// through the service layer — a second reader of the adapter's own variable and
// a Fly name outside the adapter directory, which is exactly what the
// certificate port (§6) and `tests/publicAddresses/certificatePortBoundary.test.ts`
// exist to prevent. These variables name what the value IS, not who supplies it.
//
// ⚠️ NO DEFAULTS, EVER. `tenantDomain.ts` states the rule for this whole family
// and it applies here verbatim: a guessed value would land "in DNS instructions
// a customer follows". An unset variable therefore omits its ROW — the pane then
// shows what it can prove and nothing else — rather than inventing a target the
// customer would point a domain they own at.

/** The variables, named once so a grep for either lands here. */
export const POINTING_CNAME_TARGET_ENV_VAR = 'MOTIR_PUBLIC_ADDRESS_CNAME_TARGET';
export const POINTING_A_RECORDS_ENV_VAR = 'MOTIR_PUBLIC_ADDRESS_A_RECORDS';
export const POINTING_AAAA_RECORDS_ENV_VAR = 'MOTIR_PUBLIC_ADDRESS_AAAA_RECORDS';

/**
 * Is this hostname a ROOT domain, which cannot take a `CNAME`?
 *
 * RFC 1034 §3.6.2: a name carrying a `CNAME` may carry no other record, and a
 * zone apex always carries `SOA` and `NS` — so a root domain has to be pointed
 * with address records. That is the constraint; the question here is only which
 * side of it a given hostname is on.
 *
 * ⚠️ A LABEL COUNT, AND ITS LIMIT IS NAMED RATHER THAN LEFT TO BE FOUND. Two
 * labels (`acme.com`) is a root domain; three or more (`roadmap.acme.com`) is a
 * subdomain. That is wrong for a registrable domain under a MULTI-LABEL public
 * suffix — `acme.co.uk` reads as a subdomain here and would be offered a `CNAME`
 * it cannot create. Deciding it properly needs a public-suffix list, which this
 * repository does not carry, or a live `SOA` lookup on the pane's main read.
 * Filed rather than left in a comment: see the bug logged against MOTIR-4278.
 *
 * The design asset's own note is the rung this sits on — panel 4 of
 * `design/projects/public-address.mock.html`: *"The record set follows the
 * hostname's SHAPE, decided by what was typed"*.
 */
export function isApexHostname(hostname: string): boolean {
  return normalise(hostname).split('.').length === 2;
}

/**
 * The records a customer must create so their hostname reaches us.
 *
 * NOT the ownership `TXT` — that one is minted per address and lives on the row,
 * so it is the service's to add. This function answers the half that is the same
 * for every customer and comes from configuration.
 *
 * Returns `[]` when nothing is configured for this hostname's shape, which is a
 * FIRST-CLASS state and not an error: a self-hosted build has no public
 * addresses at all (ADR §11), and a cloud deployment that has not yet been given
 * its values must show the customer no record rather than a wrong one.
 */
export function pointingRecordsFor(hostname: string): DnsInstructionDto[] {
  const name = normalise(hostname);
  if (!name) return [];

  if (isApexHostname(name)) {
    return [
      ...list(process.env['MOTIR_PUBLIC_ADDRESS_A_RECORDS']).map((value) => ({
        type: 'A' as const,
        name,
        value,
      })),
      ...list(process.env['MOTIR_PUBLIC_ADDRESS_AAAA_RECORDS']).map((value) => ({
        type: 'AAAA' as const,
        name,
        value,
      })),
    ];
  }

  const target = single(process.env['MOTIR_PUBLIC_ADDRESS_CNAME_TARGET']);
  return target ? [{ type: 'CNAME', name, value: target }] : [];
}

// ⚠️ EACH VARIABLE IS READ AT ITS LITERAL NAME, ONCE, ABOVE — never through an
// indirection. `tests/hosting/appUrlSeam.test.ts`'s single-reader rule greps the
// tree for `process.env['<NAME>']` and requires exactly this module, and a read
// through a variable is invisible to it: the guard would pass by finding NOTHING
// rather than by finding one reader, which is the same green for the opposite
// reason.

/**
 * One configured value, or `null`.
 *
 * An empty or whitespace-only value counts as UNSET — the rule `lib/baseUrl.ts`
 * and `tenantDomain.ts` both apply, for the reason they both give: a secret
 * cleared to `''` is a misconfiguration, not a value.
 */
function single(configured: string | undefined): string | null {
  const trimmed = configured?.trim();
  return trimmed ? normalise(trimmed) : null;
}

/**
 * A configured LIST, comma-separated.
 *
 * A list rather than a scalar because `fly ips list` reports a set: an app can
 * hold more than one dedicated address, and a customer whose apex is pointed at
 * only one of them is pointed at a subset of the platform.
 */
function list(configured: string | undefined): string[] {
  return (configured ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** Lower-cased, with the trailing dot a DNS name may legally carry removed. */
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}
