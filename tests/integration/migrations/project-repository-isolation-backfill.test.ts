import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { organizationIdOf } from '../../helpers/organizationOf';

const SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260909143000_project_repository_isolation_backfill/migration.sql',
  ),
  'utf8',
);

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "project_repository", "migrate_onboarding", "github_repo", "github_installation" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectedRepo(workspaceId: string, name: string) {
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${workspaceId}`,
      workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId,
      organizationId: await organizationIdOf(workspaceId),
      repoId: `host-${name}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      provider: 'github',
      archived: false,
    },
  });
}

describe('MOTIR-4955 project repository isolation backfill', () => {
  it('does not turn workspace connectivity alone into project membership', async () => {
    const fx = await makeWorkItemFixture();
    await connectedRepo(fx.workspaceId, 'unclaimed');

    await adminDb.$executeRawUnsafe(SQL);

    expect(await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } })).toEqual([]);
  });

  it('materializes the migrate-onboarding source as an explicit project link', async () => {
    const fx = await makeWorkItemFixture();
    const repo = await connectedRepo(fx.workspaceId, 'existing-app');
    await adminDb.migrateOnboarding.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'migrate',
        step: 'done',
        status: 'completed',
        connectedRepoRef: 'moooon/existing-app',
      },
    });

    await adminDb.$executeRawUnsafe(SQL);

    expect(await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } })).toEqual([
      expect.objectContaining({ githubRepoId: repo.id, name: 'existing-app', state: 'connected' }),
    ]);
  });

  it('materializes existing work-item pins idempotently before dispatch narrows', async () => {
    const fx = await makeWorkItemFixture();
    const repo = await connectedRepo(fx.workspaceId, 'motir-core');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Pinned legacy work', assigneeId: null },
      fx.ctx,
    );
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { targetRepo: 'motir-core', targetRepos: ['moooon/motir-core'] },
    });

    await adminDb.$executeRawUnsafe(SQL);
    await adminDb.$executeRawUnsafe(SQL);

    const links = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ githubRepoId: repo.id, name: 'motir-core' });
  });
});
