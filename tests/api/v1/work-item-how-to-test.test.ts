import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { currentTestInstructionsSchema } from '@/lib/api/v1/workLoop/schema';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { dispatchRunLabel } from '@/lib/howToTest/author';
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

async function connectRepo(caller: V1ProjectCaller, name: string) {
  const { fixture } = caller;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fixture.workspaceId}` },
    create: {
      installationId: `inst-${fixture.workspaceId}`,
      workspaceId: fixture.workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fixture.workspaceId,
      organizationId: await organizationIdOf(fixture.workspaceId),
      repoId: `repo-${randomToken(8)}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  await linkProjectRepo({
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    githubRepoId: repo.id,
    name,
  });
  return repo;
}

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

  // ⚠️ `repos: []` IS A RECORD (MOTIR-5689), not `record: null`. The contract's
  // array has no minimum and never had one, so this is the arm that keeps it
  // that way: a client reading the response must see the instructions, not a
  // gap, when the team that wrote them links its pull requests nowhere.
  it('answers a BODY-ONLY record with `repos: []` — never `record: null`', async () => {
    const { fixture } = caller;
    const item = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'task', title: 'Body only' },
      fixture.ctx,
    );
    await testInstructionsService.publish(
      { workItemId: item.id, bodyMd: BODY, repos: [] },
      fixture.ctx,
    );

    const res = await getHowToTest(caller, item.identifier);
    expect(res.status).toBe(200);
    const body = currentTestInstructionsSchema.parse(await res.json());
    expect(body.record).toMatchObject({ bodyMd: BODY, repos: [] });
  });

  it("names the AUTHOR: a person's record carries `kind: person`, their id and their display name", async () => {
    const { fixture } = caller;
    const item = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'story', title: 'Written by a person' },
      fixture.ctx,
    );
    const repo = await connectRepo(caller, 'web');
    // `attributeToRunningDispatch` left false — the PERSON path of §9's
    // 2026-09-17 amendment, which is the whole of what makes this a person's.
    await testInstructionsService.publish(
      {
        workItemId: item.id,
        bodyMd: BODY,
        repos: [{ repoId: repo.id, commitSha: 'a'.repeat(40) }],
      },
      fixture.ctx,
    );
    const actor = await adminDb.user.findUniqueOrThrow({ where: { id: fixture.ctx.userId } });

    const res = await getHowToTest(caller, item.identifier);
    const body = currentTestInstructionsSchema.parse(await res.json());
    expect(body.record?.dispatchRunId).toBeNull();
    expect(body.record?.author).toEqual({
      kind: 'person',
      userId: fixture.ctx.userId,
      label: actor.name,
    });
  });

  it("names the AUTHOR: a RUN's record carries `kind: run` and the run's own label", async () => {
    const { fixture } = caller;
    const item = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'story', title: 'Written by a run' },
      fixture.ctx,
    );
    const repo = await connectRepo(caller, 'web');
    const startedAt = new Date('2026-09-17T12:04:00Z');
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        command: 'run',
        status: 'running',
        startedAt,
        cards: { create: { workspaceId: fixture.workspaceId, workItemId: item.id, position: 0 } },
      },
    });
    await testInstructionsService.publish(
      {
        workItemId: item.id,
        bodyMd: BODY,
        repos: [{ repoId: repo.id, commitSha: 'a'.repeat(40) }],
        attributeToRunningDispatch: true,
      },
      fixture.ctx,
    );

    const res = await getHowToTest(caller, item.identifier);
    const body = currentTestInstructionsSchema.parse(await res.json());
    expect(body.record?.author).toEqual({
      kind: 'run',
      runId: run.id,
      label: dispatchRunLabel('run', startedAt),
    });
  });

  it('404 for an unknown item', async () => {
    const res = await getHowToTest(caller, `${caller.projectKey}-99999`);
    expect(res.status).toBe(404);
  });
});
