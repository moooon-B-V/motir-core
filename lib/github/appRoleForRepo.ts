import type { GithubAppRole } from '@/lib/github/appAuth';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';

// WHICH GITHUB APP MAY ACT ON THIS REPOSITORY (Story MOTIR-4882 · MOTIR-5511;
// `docs/decisions/approval-gates.md` §4 and its second amendment, decision 7).
//
// Motir talks to GitHub through TWO App registrations (`appAuth.ts`'s header): the
// user-facing `motir-integration`, installed where a customer's repositories live,
// and the provisioning `motir-studio`, installed ONLY on the organisation Motir
// hosts repositories under. Using the wrong one does not degrade — GitHub refuses,
// and a merge button fails for a reason the person pressing it can neither see nor
// fix. §4 says the choice *"is read from the repository row, never defaulted"*;
// this is the one place it is read.
//
// ⚠️ PROVENANCE IS `isMotirHostedOwner` AND NOTHING ELSE. Bug MOTIR-4892 found the
// hosted-owner comparison spelled three times and disagreeing about one row, so this
// module COMPOSES it — exactly as `lib/projects/prMergeModeDefault.ts` does — and
// never re-spells it.
//
// ⚠️ IT TAKES `hostOwner`, IT DOES NOT READ IT. `provisioningOrgLogin()` is a SERVER
// value; the caller resolves it once per call path and threads it down, so this
// function stays pure and callable from anywhere.
//
// The four existing hard-coded `'provisioning'` call sites (`actionsPermissions.ts`,
// `repoProvisioning.ts` ×2, `repoTransfer.ts`) do NOT route through this: they act on
// repositories Motir is creating or transferring, whose provenance is known by
// construction rather than read off a row.

/**
 * The App a credential for this repository must be minted from.
 *
 * `'provisioning'` when the repository sits under the organisation Motir provisions
 * into; `'user-facing'` for every other owner — including when `hostOwner` is `null`,
 * because a deployment that cannot provision hosts nothing (`isMotirHostedOwner`'s
 * own null arm).
 */
export function githubAppRoleForRepo(
  repo: { owner: string },
  hostOwner: string | null,
): GithubAppRole {
  return isMotirHostedOwner(repo.owner, hostOwner) ? 'provisioning' : 'user-facing';
}
