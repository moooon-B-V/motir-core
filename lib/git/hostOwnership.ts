// WHOSE IS THIS REPOSITORY — the one comparison every surface that asks reads
// (bug MOTIR-4892; the shape bug MOTIR-4867 fixed one tier down).
//
// ⚠️ IT EXISTS BECAUSE THE QUESTION HAS THREE ASKERS AND HAD THREE ANSWERS.
// `github_repo` carries a `workspace_id` AND an `organization_id` for a
// repository MOTIR provisioned — `githubInstallationService.persistProvisionedRepo`
// writes the CREATING project's tenancy onto it deliberately (MOTIR-1931,
// MOTIR-4649), so the row is reachable, dispatchable and routable inside the
// tenant that owns the project. Both columns therefore answer *"can this tenant
// dispatch into it?"*, and NEITHER answers *"whose is it?"* — the question three
// surfaces were reading them for:
//
//   - `/settings/project/repositories` (the room) — `lib/projectRepos/roomSections.ts`
//   - `/settings/organization/git` (the inventory) — `lib/mappers/organizationRepoMappers.ts`
//   - the CI meter's §5.1 gate — `lib/ciMetering/config.ts`
//
// The only fact that DOES answer it is the OWNER LOGIN: a repository Motir hosts
// sits under the provisioning organisation. Three call sites spelling that
// comparison three times is how the room and the inventory came to disagree about
// one row — so it is spelled once, here, and they cannot.
//
// ⚠️ IT TAKES `hostOwner`, IT DOES NOT READ IT. `provisioningOrgLogin()` is
// `process.env['GITHUB_FALLBACK_ORG']`, a SERVER value, and `roomSections.ts` is
// pure and client-safe on purpose — the room's split is applied on the server AND
// again in the client island after every mutation. A module that read the
// environment could not be called from both, which is how a surface ends up with
// two answers to one question. The server resolves it once and threads it down.
//
// Case-INSENSITIVE and null-safe, because a GitHub login is case-insensitive and
// the configured value is whatever an operator typed into an environment
// variable, while a webhook payload echoes the owner's stored casing.

/**
 * Does this owner login name the organisation MOTIR provisions repositories
 * under — i.e. is this a repository Motir HOSTS rather than one the customer
 * connected?
 *
 * **`hostOwner: null` classifies NOTHING**, and that is an answer rather than a
 * gap: a deployment that cannot provision (self-hosted, no `GITHUB_FALLBACK_ORG`)
 * hosts no repositories, so every caller behaves byte-for-byte as it did before
 * this rule existed.
 */
export function isMotirHostedOwner(
  owner: string | null | undefined,
  hostOwner: string | null | undefined,
): boolean {
  if (typeof hostOwner !== 'string' || typeof owner !== 'string') return false;
  const host = hostOwner.trim().toLowerCase();
  if (host.length === 0) return false;
  return owner.trim().toLowerCase() === host;
}
