import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';

/**
 * The org a fleet runner is minted in and removed from (Story MOTIR-8699 ·
 * MOTIR-8711) — decided from the INTENT, never from `isMeta`, an org id or a
 * login constant, because the intent row is what every boot, settle, reap, sweep
 * and stop path already re-reads, so the decision survives a crash, a replay and
 * a restart.
 *
 * - `undefined` when the job's repository is in the provisioning org (compared
 *   case-insensitively — GitHub logins are), or when no provisioning org is
 *   configured: the clients then act exactly as they always have, through
 *   `provisioningAuth()`.
 * - Otherwise the repository's own org, through the installation the
 *   `workflow_job` delivery arrived on.
 *
 * ⚠️ The role is `'provisioning'` on a PREMISE: a `workflow_job` delivery comes
 * only from the `motir-studio` App (MOTIR-2014 subscribes it there; the manual
 * grant verifies Motir Integration does not). If that is ever false, the token
 * mint for this installation under the provisioning role fails with
 * `OrgTargetAuthError` and the job settles `provision_failed` — a runner is never
 * minted in some other org instead.
 *
 * `projectRunnerGroupService.requireRunnerGroupIdFor(…, intent.repoOwner)` makes
 * the same case-insensitive comparison, so the group read and the runner target
 * cannot disagree about which org an intent belongs to.
 */
export function fleetRunnerTargetFor(
  intent: Pick<CiRunnerProvisioningIntent, 'repoOwner' | 'installationId'>,
): GithubOrgTarget | undefined {
  const provisioningOrg = provisioningOrgLogin();
  if (provisioningOrg === null) return undefined;
  if (intent.repoOwner.trim().toLowerCase() === provisioningOrg.trim().toLowerCase()) {
    return undefined;
  }
  return { org: intent.repoOwner, installationId: intent.installationId, role: 'provisioning' };
}
