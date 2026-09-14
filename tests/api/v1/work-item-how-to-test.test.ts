import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { currentTestInstructionsSchema } from '@/lib/api/v1/workLoop/schema';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkProjectRepo } from '../../helpers/projectRepoLink';
import { organizationIdOf } from '../../helpers/organizationOf';
import { randomToken } from '../../helpers/random';

// GET /api/v1/work-items/{key}/how-to-test (Story MOTIR-4906 · MOTIR-5358) — the
// run target's CURRENT record as the CLI reads it back to render each session
// pull request body. Real Postgres, the shipped route.

const BASE = 'http://localhost:3000/api/v1';
const BODY = '## Precondition\n\nSign in.\n\n```sh\npnpm i\n```';

async function getHowToTest(caller: V1ProjectCaller, key: string): Promise<Response> {
  const { GET } = await import('@/app/api/v1/work-items/[key]/how-to-test/route');
  return GET(new Request(`${BASE}/work-items/${key}/how-to-test`, { headers: caller.headers }), {
    params: Promise.resolve({ key }),
  });
}

describe('GET /api/v1/work-items/{key}/how-to-test', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('answers record: null for an item no run has written How to test for', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'story', title: 'Story' },
      caller.fixture.ctx,
    );
    const res = await getHowToTest(caller, item.identifier);
    expect(res.status).toBe(200);
    expect(currentTestInstructionsSchema.parse(await res.json())).toEqual({
      key: item.identifier,
      record: null,
    });
  });

  it('answers the current record with each section named owner/name, and no internal ids', async () => {
    const { fixture } = caller;
    const item = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'story', title: 'Story' },
      fixture.ctx,
    );
    const inst = await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fixture.workspaceId}`,
        workspaceId: fixture.workspaceId,
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: fixture.workspaceId,
        organizationId: await organizationIdOf(fixture.workspaceId),
        repoId: `repo-${randomToken(8)}`,
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    await linkProjectRepo({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      githubRepoId: repo.id,
      name: 'web',
    });
    await testInstructionsService.publish(
      {
        workItemId: item.id,
        bodyMd: BODY,
        repos: [{ repoId: repo.id, commitSha: 'a'.repeat(40) }],
      },
      fixture.ctx,
    );

    const res = await getHowToTest(caller, item.identifier);
    expect(res.status).toBe(200);
    const body = currentTestInstructionsSchema.parse(await res.json());
    expect(body.record).toMatchObject({
      bodyMd: BODY,
      repos: [{ repo: 'acme/web', commitSha: 'a'.repeat(40) }],
    });
    expect(JSON.stringify(body)).not.toContain(repo.id);
  });

  it('404 for an unknown item', async () => {
    const res = await getHowToTest(caller, `${caller.projectKey}-99999`);
    expect(res.status).toBe(404);
  });
});
