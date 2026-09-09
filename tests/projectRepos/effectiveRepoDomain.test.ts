import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { resolveEffectiveRepoDomain } from '@/lib/projectRepos/effectiveDomain';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoRoomService } from '@/lib/services/projectRepoRoomService';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { organizationIdOf } from '../helpers/organizationOf';
import { randomToken } from '../helpers/random';

beforeEach(truncateAuthTables);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectRepo(workspaceId: string, name: string) {
  const installation = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${workspaceId}` },
    create: {
      installationId: `inst-${workspaceId}`,
      workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId,
      organizationId: await organizationIdOf(workspaceId),
      repoId: `${name}-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      provider: 'github',
      archived: false,
    },
  });
}

describe('resolveEffectiveRepoDomain — project_repository is the isolation boundary', () => {
  it('an unlinked project reaches nothing even when its workspace has repositories', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'workspace-only');

    const domain = await resolveEffectiveRepoDomain(fx.projectId, fx.ctx);

    expect(domain).toMatchObject({
      scope: 'project',
      hasSet: false,
      layersConnected: false,
      connected: [],
      dispatchable: [],
      pinnable: [],
      projectRows: [],
    });
  });

  it('returns only repositories explicitly linked to this project', async () => {
    const fx = await makeWorkItemFixture();
    const linked = await connectRepo(fx.workspaceId, 'linked');
    await connectRepo(fx.workspaceId, 'unlinked');
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'other', name: linked.name },
      fx.ctx,
    );
    await projectRepoSetService.attachRealizedRepo(row.id, linked.id, fx.ctx);

    const domain = await resolveEffectiveRepoDomain(fx.projectId, fx.ctx);

    expect(domain.dispatchable.map((repo) => repo.repoRef)).toEqual(['moooon/linked']);
    expect(domain.pinnable.map((repo) => repo.repoRef)).toEqual(['moooon/linked']);
    expect(domain.connected).toEqual([]);
  });

  it('the repository room agrees that workspace-only repositories are outside the project', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'workspace-only');

    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);

    expect(view.rows).toEqual([]);
    expect(view.connected).toEqual([]);
    expect(view.connectedInDomain).toBe(false);
  });
});
