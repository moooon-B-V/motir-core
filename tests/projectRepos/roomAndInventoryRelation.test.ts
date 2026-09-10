import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { projectRepoRoomService } from '@/lib/services/projectRepoRoomService';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { organizationIdOf } from '../helpers/organizationOf';

beforeEach(truncateAuthTables);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('project repository surfaces share the explicit-link boundary', () => {
  it('workspace connectivity alone appears in neither the room nor Used by', async () => {
    const fx = await makeWorkItemFixture();
    const installation = await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: fx.workspaceId,
        organizationId: await organizationIdOf(fx.workspaceId),
        repoId: 'host-repo',
        owner: 'moooon',
        name: 'workspace-only',
        defaultBranch: 'main',
        provider: 'github',
        archived: false,
      },
    });

    const [room, usage] = await Promise.all([
      projectRepoRoomService.getRoomView(fx.projectId, fx.ctx),
      organizationRepoService.listRepositoryUsage(fx.ctx),
    ]);

    expect(room.connected).toEqual([]);
    expect(room.connectedInDomain).toBe(false);
    expect(usage.find((row) => row.githubRepoId === repo.id)?.projects).toEqual([]);
  });
});
