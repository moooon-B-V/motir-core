import { provisioningOrgLogin } from './config';

// THE MOTIR-OWNED GITHUB ORG SET (MOTIR-1934) — the orgs whose Actions bill
// Motir pays, as CONFIGURATION rather than a literal.
//
// ⚠️ THIS IS NOT A SECOND DECLARATION. The set already exists: it is
// `GITHUB_FALLBACK_ORG`, read by `provisioningOrgLogin()` in `./config.ts`, and
// it is the same key the meter's §5.1 gate (`isMotirOwnedRepo`) decides "does
// Motir pay for this run?" with. This module only names it as a SET, so a
// reader that iterates owned orgs (the hosted-run probe) does not assume there
// is exactly one. Its degenerate case is one org (`motir-projects`), and with
// the variable unset it is EMPTY — a self-hosted build owns no org at all.
//
// An org whose repositories were handed over to a customer (MOTIR-711) is not
// in it: the transfer moves the repo OUT of the provisioning org, so the owner
// a run reports afterwards simply stops matching. Adding or removing an owned
// org is therefore a change to the environment, never to a caller.

/** Every GitHub org login Motir owns, lowercased for comparison. Empty when none is configured. */
export function motirOwnedOrgLogins(): string[] {
  const login = provisioningOrgLogin();
  return login ? [login.toLowerCase()] : [];
}
