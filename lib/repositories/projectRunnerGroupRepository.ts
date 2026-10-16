import type { Prisma, ProjectRunnerGroup } from '@/generated/prisma/client';

// A project's runner groups in CONNECTED orgs (Story MOTIR-8699 · MOTIR-8712).
// The provisioning org's group is NOT here — it stays on `Project.runnerGroup*`
// (`projectRepository.setRunnerGroup`). Single-op methods; every caller is
// `projectRunnerGroupService`, under the project's `FOR UPDATE` lock for writes.
// `org` is always the lower-cased login: callers pass it normalised.

/** The facts one connected-org group row records. */
export interface ProjectRunnerGroupUpsert {
  projectId: string;
  workspaceId: string;
  org: string;
  installationId: string;
  runnerGroupId: number;
  runnerGroupName: string;
  syncedAt: Date | null;
  syncPending: boolean;
}

export const projectRunnerGroupRepository = {
  async listForProject(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRunnerGroup[]> {
    return tx.projectRunnerGroup.findMany({
      where: { projectId, workspaceId },
      orderBy: { org: 'asc' },
    });
  },

  async findForOrg(
    projectId: string,
    org: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRunnerGroup | null> {
    return tx.projectRunnerGroup.findUnique({ where: { projectId_org: { projectId, org } } });
  },

  async upsertForOrg(
    row: ProjectRunnerGroupUpsert,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRunnerGroup> {
    const { projectId, org, ...rest } = row;
    return tx.projectRunnerGroup.upsert({
      where: { projectId_org: { projectId, org } },
      create: { projectId, org, ...rest },
      update: {
        installationId: rest.installationId,
        runnerGroupId: rest.runnerGroupId,
        runnerGroupName: rest.runnerGroupName,
        syncedAt: rest.syncedAt,
        syncPending: rest.syncPending,
      },
    });
  },

  /** Mark one org's group out of sync. A no-op (count 0) when the org has no row
   *  yet — a first sync that failed before any group existed has nothing to mark. */
  async markPendingForOrg(
    projectId: string,
    org: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.projectRunnerGroup.updateMany({
      where: { projectId, org },
      data: { syncPending: true },
    });
    return result.count;
  },

  async deleteForOrg(
    projectId: string,
    org: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.projectRunnerGroup.deleteMany({ where: { projectId, org } });
    return result.count;
  },
};
