import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { codeGraphRefresh } from '@/lib/jobs/definitions/codeGraphRefresh';
import * as motirAiClient from '@/lib/ai/motirAiClient';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// system.code-graph-index / -refresh — the STEP SHAPE (MOTIR-1974). Driven
// IN-PROCESS via @inngest/test against a REAL Postgres, with only the two
// externals stubbed (the GitHub tarball fetch, the motir-ai upload).
//
// What is under test is not "does it index" — the service test covers that —
// but the DURABLE SHAPE, because the shape is what failed in production. Both
// jobs used to do everything in one `step.run`, so a single platform invocation
// had to cover the fetch plus one upload per project; every production run hit
// `FUNCTION_INVOCATION_TIMEOUT` and dead-lettered, tiny repos included. A run
// must now checkpoint BETWEEN projects, which is exactly what these assertions
// pin: the number of steps, and their ids.
//
// @inngest/test hands back a mocked `ctx`, so `ctx.step.run` is a spy and the
// step ids it was called with are directly assertable — the closest thing to
// observing the executor's checkpoints from a unit test.

const PASSWORD = 'hunter2hunter2';
const TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x11, 0x22]);

function stubGithubTarball(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_x',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/tarball/')) return new Response(TARBALL, { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }),
  );
}

/** Seed a workspace with `projectCount` projects + one connected repo. */
async function seedWorkspace(
  slug: string,
  projectCount: number,
): Promise<{ workspaceId: string; projectIds: string[]; installationId: string }> {
  const user = await usersService.createUser({
    email: `${slug}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: user.id,
  });
  // Drop any auto-seeded project so the count is exactly what the test asked for.
  await db.project.deleteMany({ where: { workspaceId: workspace.id } });
  const projectIds: string[] = [];
  for (let i = 0; i < projectCount; i += 1) {
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: `P${i}`,
      identifier: `PRJ${i}${slug.slice(-1).toUpperCase()}`,
    });
    projectIds.push(project.id);
  }
  const installationId = `inst-${slug}`;
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId, accountLogin: 'moooon', accountType: 'Organization' },
    repos: [
      {
        providerRepoId: '77',
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { workspaceId: workspace.id, projectIds, installationId };
}

/** The step ids a run passed to `step.run`, in call order. */
function stepIds(ctx: { step: { run: { mock: { calls: unknown[][] } } } }): string[] {
  return ctx.step.run.mock.calls.map((call) => String(call[0]));
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('system.code-graph-index — one checkpointed step per project', () => {
  it('resolves in its own step, then indexes each project in a step of its own', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgj-multi', 3);
    stubGithubTarball();
    const indexSpy = vi.spyOn(motirAiClient, 'indexCodeGraph').mockResolvedValue({
      status: 'ok',
      repoRef: 'moooon/motir-core',
      filesIndexed: 12,
      nodesChanged: 3,
      edgesChanged: 4,
      commitSha: 'abc',
    });

    const engine = new InngestTestEngine({
      function: codeGraphIndex,
      events: [
        {
          name: 'system.code-graph-index',
          data: {
            installationId,
            workspaceId,
            repoOwner: 'moooon',
            repoName: 'motir-core',
            defaultBranch: 'main',
            archived: false,
          },
        },
      ],
    });
    const { result, ctx } = await engine.execute();

    expect(result).toEqual({ indexed: true, repoRef: 'moooon/motir-core', projectsIndexed: 3 });
    expect(indexSpy).toHaveBeenCalledTimes(3);

    // THE REGRESSION. The work is spread over one resolve step plus a step per
    // project — never a single step covering the fetch and all three uploads,
    // which is the shape that could not finish inside one invocation. (The
    // `job-run:*` steps are the defineJob ledger wrapper's own.)
    const ids = stepIds(ctx).filter((id) => !id.startsWith('job-run:'));
    expect(ids[0]).toBe('resolve-target');
    expect(ids.slice(1).sort()).toEqual(projectIds.map((id) => `index-project:${id}`).sort());
    expect(ids).toHaveLength(4);
  });

  it('keys each project step by project id, so a replay memoizes the same unit of work', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgj-key', 1);
    stubGithubTarball();
    vi.spyOn(motirAiClient, 'indexCodeGraph').mockResolvedValue({
      status: 'ok',
      repoRef: 'moooon/motir-core',
      filesIndexed: 1,
      nodesChanged: 0,
      edgesChanged: 0,
      commitSha: 'abc',
    });

    const engine = new InngestTestEngine({
      function: codeGraphIndex,
      events: [
        {
          name: 'system.code-graph-index',
          data: {
            installationId,
            workspaceId,
            repoOwner: 'moooon',
            repoName: 'motir-core',
            defaultBranch: 'main',
          },
        },
      ],
    });
    const { ctx } = await engine.execute();

    // A positional id ('index-project:0') would re-point at a different project
    // if the workspace's project list changed between attempts; the project id
    // cannot.
    expect(stepIds(ctx)).toContain(`index-project:${projectIds[0]}`);
  });

  it('resolves in ONE step and skips the fan-out entirely for a vanished tenant', async () => {
    const engine = new InngestTestEngine({
      function: codeGraphIndex,
      events: [
        {
          name: 'system.code-graph-index',
          data: {
            installationId: 'inst-gone',
            workspaceId: 'ws-gone',
            repoOwner: 'moooon',
            repoName: 'motir-core',
            defaultBranch: 'main',
          },
        },
      ],
    });
    const { result, ctx } = await engine.execute();

    expect(result).toEqual({ indexed: false, reason: 'installation_missing' });
    expect(stepIds(ctx).filter((id) => id.startsWith('index-project:'))).toEqual([]);
  });
});

describe('system.code-graph-refresh — the same shape', () => {
  it('checkpoints per project too (it drives the same steps as the index job)', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgj-refresh', 2);
    stubGithubTarball();
    vi.spyOn(motirAiClient, 'indexCodeGraph').mockResolvedValue({
      status: 'ok',
      repoRef: 'moooon/motir-core',
      filesIndexed: 5,
      nodesChanged: 1,
      edgesChanged: 1,
      commitSha: 'def',
    });

    const engine = new InngestTestEngine({
      function: codeGraphRefresh,
      events: [
        {
          name: 'system.code-graph-refresh',
          data: {
            installationId,
            workspaceId,
            repoOwner: 'moooon',
            repoName: 'motir-core',
            defaultBranch: 'main',
            archived: false,
          },
        },
      ],
    });
    const { result, ctx } = await engine.execute();

    expect(result).toEqual({ indexed: true, repoRef: 'moooon/motir-core', projectsIndexed: 2 });
    const ids = stepIds(ctx).filter((id) => id.startsWith('index-project:'));
    expect(ids.sort()).toEqual(projectIds.map((id) => `index-project:${id}`).sort());
  });
});
