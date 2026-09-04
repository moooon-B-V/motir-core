import { getDomain } from 'tldts';

import type { DnsInstructionDto } from '@/lib/dto/publicAddresses';

// THE RECORDS THAT POINT A CUSTOMER HOSTNAME AT US — Story MOTIR-3878 ·
// MOTIR-4278 · MOTIR-4315.
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
 * Is this hostname a ZONE APEX, which cannot take a `CNAME`?
 *
 * RFC 1034 §3.6.2: a name carrying a `CNAME` may carry no other record, and a
 * zone apex always carries `SOA` and `NS` — so a root domain has to be pointed
 * with address records. That is the constraint; the question here is only which
 * side of it a given hostname is on.
 *
 * ⚠️ THE HOSTNAME EQUALS ITS OWN REGISTRABLE DOMAIN — a public-suffix reading,
 * not a label count (MOTIR-4315). `acme.co.uk` is three labels and IS a root
 * domain; `roadmap.acme.com` is three labels and is not. Nothing about the
 * NUMBER of labels separates them, so the list that knows where the registry
 * boundary falls is the only thing that can. `tldts` carries the Public Suffix
 * List offline, which is what keeps this synchronous — and `toDto` synchronous
 * with it, over a database row, per the note at the top of this file.
 *
 * ⚠️ THE **ICANN** SECTION ONLY, AND THAT IS THE DECISION RATHER THAN THE
 * DEFAULT. The PSL's PRIVATE section lists names like `github.io` that a
 * registrar never delegated — DNS-wise they are ordinary records inside their
 * own zone, and a name beneath one takes a `CNAME` perfectly legally. Reading
 * them as suffixes (`allowPrivateDomains: true`) would call `myapp.github.io` an
 * apex and hand a customer address records for a name that wanted a `CNAME`,
 * which is this bug pointing the other way. Only an ICANN suffix marks the
 * delegation a registrant's zone actually begins at.
 *
 * ⚠️ ITS OWN LIMITS, NAMED RATHER THAN LEFT TO BE FOUND — the label count's
 * were, and that is the only reason this one was ever findable. Both are
 * asserted in `tests/publicAddresses/pointingRecords.test.ts`, so neither can be
 * re-introduced as a surprise.
 *
 *   1. **THE LIST AGES, AND IT AGES BACK INTO THIS BUG.** A public suffix added
 *      to the PSL after the `tldts` version in `package.json` is unknown here,
 *      and an unknown suffix degrades to exactly the rule this replaced: the
 *      last label is taken as the suffix, so a registrable domain under a NEW
 *      multi-label suffix reads as a subdomain and is offered a `CNAME` it
 *      cannot create. The refresh is a dependency bump (`pnpm up tldts`) rather
 *      than a schema change, which is why this mechanism was chosen over a live
 *      lookup.
 *   2. **A PRIVATELY DELEGATED SUBZONE IS INVISIBLE TO ANY LIST.** A customer
 *      who has delegated `roadmap.acme.co.uk` with `NS` records has a zone apex
 *      there, carrying `SOA`, and it cannot take a `CNAME` either. No public
 *      list can know a delegation nobody published; only a live `SOA` lookup on
 *      the name itself can, and `list` is the pane's main read, so that answer
 *      would have to be resolved once at `add` and persisted — a migration, and
 *      the second option MOTIR-4315 weighed. Filed there rather than left in a
 *      comment; re-open it if a customer meets it.
 *
 * The design asset's own note is the rung this sits on — panel 4 of
 * `design/projects/public-address.mock.html`: *"The record set follows the
 * hostname's SHAPE, decided by what was typed"*.
 */
export function isApexHostname(hostname: string): boolean {
  const name = normalise(hostname);
  if (!name) return false;
  // `getDomain` answers `null` for a name with no registrable domain at all — a
  // single label, an IP literal — and `null` is not `name`, so those read as
  // subdomains exactly as the label count read them. Neither reaches here in
  // practice: `normaliseCustomHostname` refuses a single label at the door.
  return getDomain(name, { allowPrivateDomains: false }) === name;
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
