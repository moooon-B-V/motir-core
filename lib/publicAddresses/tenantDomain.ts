// THE BASE DOMAIN — Story MOTIR-3878 · Subtask MOTIR-4215.
//
// `docs/decisions/public-tenant-addresses.md` §2 fixes the SHAPE the base domain
// must have and deliberately does NOT fix the string: MOTIR-4208 buys one and
// MOTIR-4214 sets it. This module is the single place the value enters the
// application, which is what makes that possible — no module contains the
// domain, no test asserts it, and changing it is a Fly secret rather than a pull
// request.
//
// ⚠️ ONE READER, ASSERTED. `tests/hosting/appUrlSeam.test.ts`'s single-reader
// rule greps the tree for `process.env['MOTIR_PUBLIC_TENANT_DOMAIN']` and
// requires exactly this file. A second reader is a second answer to a question
// this module exists to answer once — the drift `lib/baseUrl.ts`'s own comment
// was written against.
//
// ⚠️ READ AT CALL TIME, never at module load (`appAuth.ts`'s contract). A
// self-hosted build has no public projects (ADR §11) and therefore no tenant
// addresses; it must be unable to reach this path, not unable to boot.

/** The variable, named once so a grep for it lands here. */
export const TENANT_DOMAIN_ENV_VAR = 'MOTIR_PUBLIC_TENANT_DOMAIN';

/**
 * Thrown when the base domain is unset.
 *
 * ⚠️ THERE IS NO DEFAULT, and that is the opposite choice from
 * `motir-marketing`'s `siteOrigin.ts`, which defaults to `https://motir.co`.
 * The difference is what a wrong answer costs. That module answers "where do I
 * live?", has exactly one right production value, and a wrong guess costs a
 * canonical. This one answers "what namespace do customer addresses hang off?",
 * and a guessed value would mint hostnames — in a database, in DNS instructions
 * a customer follows, in a certificate request — under a domain nobody owns.
 * A refusal is the only honest unconfigured behaviour.
 */
export class TenantDomainNotConfiguredError extends Error {
  readonly code = 'TENANT_DOMAIN_NOT_CONFIGURED' as const;
  constructor() {
    super(
      `${TENANT_DOMAIN_ENV_VAR} is not set. Public tenant addresses need a base domain ` +
        `(docs/decisions/public-tenant-addresses.md §2).`,
    );
    this.name = 'TenantDomainNotConfiguredError';
  }
}

/**
 * The base domain every tenant subdomain hangs off, e.g. `motir.site`.
 *
 * An empty or whitespace-only value counts as UNSET — the same rule
 * `lib/baseUrl.ts` applies, for the same reason: a secret cleared to `''` is a
 * misconfiguration, not a domain.
 */
export function tenantBaseDomain(): string {
  const configured = process.env[TENANT_DOMAIN_ENV_VAR]?.trim();
  if (!configured) throw new TenantDomainNotConfiguredError();
  // A trailing dot is legal in DNS and wrong in a URL, and a leading one is a
  // typo that would mint `acme..motir.site`. Normalised here so every caller
  // gets the same string rather than each defending against it.
  return configured.replace(/^\.+/, '').replace(/\.+$/, '').toLowerCase();
}

/** Is a base domain configured? Never throws — for a gate that must not. */
export function isTenantDomainConfigured(): boolean {
  return Boolean(process.env[TENANT_DOMAIN_ENV_VAR]?.trim());
}

/** The hostname a label claims: `<label>.<base>`. */
export function tenantHostname(label: string): string {
  return `${label}.${tenantBaseDomain()}`;
}
