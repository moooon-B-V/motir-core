import type { FleetShard, Prisma } from '@/generated/prisma/client';
import { bindOrganizationContext } from '@/lib/organizations/context';
import { withSystemContext } from '@/lib/workspaces/context';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import { GITHUB_SECONDARY_LIMITS, tenantsPerShard } from '@/lib/ciFleet/shardTargets';
import type { GithubAppRole } from '@/lib/github/appAuth';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';

// WHICH MOTIR-OWNED GITHUB ORG A TENANT IS HOSTED IN (Story MOTIR-8953 · MOTIR-8966)
// — `docs/decisions/fleet-per-org-pool.md` AMENDMENT 1.
//
// GitHub counts runner registrations and API calls per ORG, whichever account
// boots the machine, so adding machine capacity never relieves the one org every
// tenant lands in. This assigns each organisation a GitHub org the first time
// one of its hosted repositories is about to be created — the org, among those
// the active fleet accounts name, with the most GitHub headroom — and records it
// on the organisation. Every later hosted repository of the organisation is
// created there.
//
// ⚠️ A GITHUB ORG, NOT A MACHINE ACCOUNT. Admission picks a job's account per job
// from its fleet kind's pool (`fleetShardAdmissionService`) and never reads this.
//
// ⚠️ THE COUNT IS READ-DERIVED, SO IT IS LOCKED, AND IT SPANS EVERY TENANT. One
// system-context transaction locks the organisation row (two projects of one
// organisation assign it once), then the active account rows that name a GitHub
// org in id order (two organisations see each other's assignment and cannot
// deadlock), counts, picks and writes. A workspace-scoped count would return a
// smaller, believable number and over-fill an org.
//
// "First hosted repository" is decided by what exists: an organisation with no
// assigned org but an established repository in the fallback org stays
// unassigned, so all of its repositories stay in one org.

export type HostedGithubOrgOutcome =
  /** Newly assigned by this call. */
  | { outcome: 'assigned'; githubOrg: string; target: GithubOrgTarget }
  /** Assigned before. `target` is null when no account row names the org any more
   *  — the repository then goes nowhere rather than to the fallback org. */
  | { outcome: 'already_assigned'; githubOrg: string; target: GithubOrgTarget | null }
  /** Hosted in the fallback org already and never assigned: stays there. */
  | { outcome: 'existing_hosting' }
  /** No active account names a GitHub org: the fallback org, as before. */
  | { outcome: 'no_github_org' };

/** One GitHub org's place in the choice. */
interface GithubOrgCandidate {
  /** Lower-cased login — the key counts are compared on. */
  key: string;
  /** The login as the account rows spell it. */
  login: string;
  headroom: number;
  earliestCreatedAt: Date;
  rows: FleetShard[];
}

/**
 * The `GithubOrgTarget` for a GitHub org, built from the account rows that name it
 * (case-insensitive). They carry the same installation; an active row is
 * preferred, then the oldest. Null when no row names it.
 */
export function orgTargetForGithubOrg(
  login: string,
  shards: readonly FleetShard[],
): GithubOrgTarget | null {
  const key = login.trim().toLowerCase();
  const naming = shards
    .filter((shard) => shard.githubOrg.trim().toLowerCase() === key)
    .sort(
      (a, b) =>
        Number(b.state === 'active') - Number(a.state === 'active') ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  const shard = naming[0];
  if (!shard) return null;
  return {
    org: shard.githubOrg,
    installationId: shard.githubInstallationId,
    role: shard.githubAppRole as GithubAppRole,
  };
}

/** The smallest recorded value of one limit across the rows, or null. */
function smallest(values: ReadonlyArray<number | null>): number | null {
  const recorded = values.filter((value): value is number => value !== null);
  return recorded.length === 0 ? null : Math.min(...recorded);
}

/** The GitHub orgs the rows name, each with its headroom. */
function candidatesFrom(
  shards: readonly FleetShard[],
  assigned: ReadonlyMap<string, number>,
): GithubOrgCandidate[] {
  const byOrg = new Map<string, FleetShard[]>();
  for (const shard of shards) {
    const key = shard.githubOrg.trim().toLowerCase();
    if (!key) continue;
    byOrg.set(key, [...(byOrg.get(key) ?? []), shard]);
  }
  return [...byOrg.entries()].map(([key, rows]) => {
    // GitHub's limits only — machines come from the shared pools, not the org.
    const { tenants } = tenantsPerShard({
      registrationsPer5Min: smallest(rows.map((row) => row.githubRegistrationsPer5Min)),
      installationApiPerHour: smallest(rows.map((row) => row.githubApiPerHour)),
      secondaryLimits: Object.values(GITHUB_SECONDARY_LIMITS),
    });
    const oldest = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;
    return {
      key,
      login: oldest.githubOrg.trim(),
      headroom: tenants - (assigned.get(key) ?? 0),
      earliestCreatedAt: oldest.createdAt,
      rows,
    };
  });
}

/** Most headroom; ties to the earlier-created row, then the login. */
function best(candidates: readonly GithubOrgCandidate[]): GithubOrgCandidate | null {
  return (
    [...candidates].sort(
      (a, b) =>
        b.headroom - a.headroom ||
        a.earliestCreatedAt.getTime() - b.earliestCreatedAt.getTime() ||
        a.key.localeCompare(b.key),
    )[0] ?? null
  );
}

/**
 * True when the organisation already has a repository established in the
 * fallback (provisioning) org — its own transaction, bound to the tenant:
 * `project_repository` has no system-admin read arm, so under `motir_app` a
 * system-context read of it returns zero rows and raises nothing.
 */
async function hasExistingHosting(organizationId: string): Promise<boolean> {
  const fallback = provisioningOrgLogin();
  if (!fallback) return false;
  return withSystemContext(async (tx) => {
    await bindOrganizationContext(tx, organizationId);
    return projectRepoRepository.hasEstablishedHostedRepoForOrganizationInTx(
      organizationId,
      fallback,
      tx,
    );
  });
}

async function ensureInTx(
  organizationId: string,
  existingHosting: boolean,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<HostedGithubOrgOutcome> {
  // LOCK, then re-read: a concurrent establish of another project of this
  // organisation waits here and then sees the org this call wrote.
  await organizationRepository.lockByIdForUpdate(organizationId, tx);
  const current = await organizationRepository.findHostedGithubOrgInTx(organizationId, tx);
  if (current) {
    const naming = await fleetShardRepository.listByGithubOrgInTx(current, tx);
    return {
      outcome: 'already_assigned',
      githubOrg: current,
      target: orgTargetForGithubOrg(current, naming),
    };
  }

  if (existingHosting) return { outcome: 'existing_hosting' };

  const shards = await fleetShardRepository.lockActiveWithGithubOrgInTx(tx);
  if (shards.length === 0) return { outcome: 'no_github_org' };

  const assigned = await organizationRepository.countByHostedGithubOrgInTx(
    shards.map((shard) => shard.githubOrg),
    tx,
  );
  const chosen = best(candidatesFrom(shards, assigned))!;
  if (chosen.headroom <= 0) {
    // Assigned anyway — an establish is never blocked over a sizing target. The
    // headroom reading is the real signal; this line tells the operator to add an
    // org.
    console.warn(
      '[fleetGithubOrgAssignmentService] every GitHub org is at its tenant target — ' +
        'assigning the best one anyway; add a GitHub org',
      { githubOrg: chosen.login, headroom: chosen.headroom },
    );
  }
  await organizationRepository.setHostedGithubOrgInTx(organizationId, chosen.login, now, tx);
  return {
    outcome: 'assigned',
    githubOrg: chosen.login,
    target: orgTargetForGithubOrg(chosen.login, chosen.rows)!,
  };
}

export const fleetGithubOrgAssignmentService = {
  /**
   * The assigned org's target for the organisation that owns a workspace, or
   * undefined when it has none (or no account row names it any more) — how a
   * runner-group sync that was not handed the org finds it, so a later sync never
   * makes a group in the fallback org for a project hosted elsewhere, nor deletes
   * the assigned org's group before its first repository settles.
   */
  async hostedTargetForWorkspace(workspaceId: string): Promise<GithubOrgTarget | undefined> {
    return withSystemContext(async (tx) => {
      const workspace = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { organizationId: true },
      });
      if (!workspace) return undefined;
      const current = await organizationRepository.findHostedGithubOrgInTx(
        workspace.organizationId,
        tx,
      );
      if (!current) return undefined;
      const naming = await fleetShardRepository.listByGithubOrgInTx(current, tx);
      return orgTargetForGithubOrg(current, naming) ?? undefined;
    });
  },

  /**
   * The organisation's assigned GitHub org and its target, WITHOUT assigning one —
   * for an establish run that will create nothing. Null when it has none.
   */
  async readHostedGithubOrg(
    organizationId: string,
  ): Promise<{ githubOrg: string; target: GithubOrgTarget | null } | null> {
    return withSystemContext(async (tx) => {
      const current = await organizationRepository.findHostedGithubOrgInTx(organizationId, tx);
      if (!current) return null;
      const naming = await fleetShardRepository.listByGithubOrgInTx(current, tx);
      return { githubOrg: current, target: orgTargetForGithubOrg(current, naming) };
    });
  },

  /**
   * Assign the organisation its hosted GitHub org if it has none, or report the
   * one it has. SYSTEM CONTEXT: the count spans every tenant.
   *
   * SECURITY: `organizationId` must be server-resolved (from the workspace row),
   * never request input.
   */
  async ensureHostedGithubOrg(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<HostedGithubOrgOutcome> {
    const existingHosting = await hasExistingHosting(organizationId);
    return withSystemContext((tx) => ensureInTx(organizationId, existingHosting, now, tx));
  },
};
