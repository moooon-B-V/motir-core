import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { resolveCodeContextState } from '@/lib/services/codeContextService';

// THE /code DTO CARRIES A SIZE REFUSAL (Story MOTIR-7092 · MOTIR-7132).
//
// `graphTooLarge` is built from the three `GithubRepo.indexRefused*` columns the
// settle writes (MOTIR-7130) and clears together, with `indexRefusedAt` as the
// switch. Real Postgres, through the same set read the Code page uses.

let fx: WorkItemFixture;
let installationRowId: string;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  installationRowId = installation.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedLinkedRepo(refusal: {
  sizeBytes: bigint | null;
  capBytes: bigint | null;
  at: Date | null;
}) {
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installationRowId,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: 'host-web',
      owner: 'moooon',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
      archived: false,
      indexedHeadSha: 'base1',
      defaultBranchHeadSha: 'head9',
      indexRefusedSizeBytes: refusal.sizeBytes,
      indexRefusedCapBytes: refusal.capBytes,
      indexRefusedAt: refusal.at,
    },
  });
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'web' },
    fx.ctx,
  );
  await adminDb.projectRepo.update({ where: { id: row.id }, data: { githubRepoId: repo.id } });
}

async function readRow() {
  const state = await resolveCodeContextState(fx.projectId, {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
  });
  return state.repos[0];
}

describe('CodeContextRepoDTO.graphTooLarge', () => {
  it('carries both numbers when a refusal is recorded', async () => {
    await seedLinkedRepo({
      sizeBytes: BigInt(1_503_238_553),
      capBytes: BigInt(1_073_741_824),
      at: new Date(),
    });

    expect((await readRow())?.graphTooLarge).toEqual({
      sizeBytes: 1_503_238_553,
      capBytes: 1_073_741_824,
    });
  });

  it('is null when no refusal is recorded', async () => {
    await seedLinkedRepo({ sizeBytes: null, capBytes: null, at: null });
    expect((await readRow())?.graphTooLarge).toBeNull();
  });

  it('is null when indexRefusedAt is null, whatever the size columns hold', async () => {
    await seedLinkedRepo({
      sizeBytes: BigInt(1_503_238_553),
      capBytes: BigInt(1_073_741_824),
      at: null,
    });
    expect((await readRow())?.graphTooLarge).toBeNull();
  });
});
