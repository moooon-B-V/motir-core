import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import * as motirAiClient from '@/lib/ai/motirAiClient';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { truncateAuthTables } from '../helpers/db';

// Story 7.5 · MOTIR-1500 — the code-graph index service, the producer half. Real
// Postgres (the motir-core convention): seed an installation + workspace + N
// projects, stub the GitHub tarball fetch (global `fetch`), and spy the motir-ai
// boundary. Asserts the workspace→projects fan-out this service resolves.
//
// ⚠️ IT IS A READ-ONLY SERVICE NOW (MOTIR-2057). MOTIR-1974 split it into
// `resolveIndexTarget` (reads) + `indexRepoIntoProject` (ONE project's fetch +
// upload); the second half is DELETED, because both code-graph jobs build in a
// fleet container and the in-function bytes path is exactly what failed ~68% of
// `motir-core`'s refreshes. So the stubbed `fetch` and the motir-ai spy below are
// kept as TRIPWIRES — they must record nothing — and the dispatch shape both jobs
// now share lives in `tests/jobs/code-graph-index.test.ts`.

const PASSWORD = 'hunter2hunter2';
const TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xaa, 0xbb]);

function stubGithubTarball(): ReturnType<typeof vi.fn> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
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
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  await truncateAuthTables();
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

describe('codeGraphIndexService — resolve, then index one project per step', () => {
  it('resolves every project of the workspace, and indexes the tarball into each', async () => {
    const user = await usersService.createUser({
      email: 'cg-svc@example.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: user.id,
    });
    const projectA = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Alpha',
      identifier: 'ALPHA',
    });
    const projectB = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Beta',
      identifier: 'BETAX',
    });
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-cg',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: '555',
          owner: 'moooon',
          name: 'acme',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

    const fetchMock = stubGithubTarball();
    const indexSpy = vi.spyOn(motirAiClient, 'indexCodeGraph').mockResolvedValue({
      status: 'ok',
      repoRef: 'moooon/acme',
      filesIndexed: 3,
      nodesChanged: 5,
      edgesChanged: 7,
      commitSha: 'abc',
    });

    const input = {
      installationId: 'inst-cg',
      workspaceId: workspace.id,
      repoOwner: 'moooon',
      repoName: 'acme',
      defaultBranch: 'main',
      archived: false,
    };

    // Phase 1 — reads only. It touches NO network (this is what makes it cheap
    // to replay at every later step boundary).
    const target = await codeGraphIndexService.resolveIndexTarget(input);
    expect(target).toEqual({
      indexed: true,
      repoRef: 'moooon/acme',
      providerId: 'github',
      organizationId: workspace.organizationId,
      projectIds: expect.arrayContaining([projectA.id, projectB.id]),
    });
    expect(target.indexed && target.projectIds).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/tarball/'))).toHaveLength(0);
    expect(indexSpy).not.toHaveBeenCalled();

    // ⚠️ AND THERE IS NO PHASE 2 IN THIS SERVICE ANY MORE (MOTIR-2057). It owned
    // `indexRepoIntoProject` — one project's tarball fetch + bytes upload — which
    // BOTH jobs used to drive and which only `system.code-graph-refresh` was
    // still on after MOTIR-2027. That method is deleted, and this assertion is
    // what keeps it deleted: a service that can pull a repo into the function is
    // one import away from re-creating the 180 s-bounded path that failed ~68% of
    // `motir-core`'s refreshes. Building now happens in a container, dispatched
    // by `codeGraphIndexDispatchService` from `lib/jobs/indexFleetSteps.ts`.
    expect('indexRepoIntoProject' in codeGraphIndexService).toBe(false);
    expect(indexSpy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/tarball/'))).toHaveLength(0);
  });

  it('no-ops cleanly when the workspace has no projects', async () => {
    const user = await usersService.createUser({
      email: 'cg-empty@example.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Empty',
      ownerUserId: user.id,
    });
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-empty', accountLogin: 'moooon', accountType: 'User' },
      repos: [
        { providerRepoId: '1', owner: 'moooon', name: 'r', defaultBranch: 'main', archived: false },
      ],
    });

    // Auto-created workspaces may seed a default project; remove any so the
    // "no projects" branch is exercised deterministically.
    await db.project.deleteMany({ where: { workspaceId: workspace.id } });

    const fetchMock = stubGithubTarball();
    const indexSpy = vi.spyOn(motirAiClient, 'indexCodeGraph');

    const res = await codeGraphIndexService.resolveIndexTarget({
      installationId: 'inst-empty',
      workspaceId: workspace.id,
      repoOwner: 'moooon',
      repoName: 'r',
      defaultBranch: 'main',
    });

    expect(res).toEqual({ indexed: false, reason: 'no_projects' });
    // Never fetched a tarball, never called motir-ai.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/tarball/'))).toHaveLength(0);
    expect(indexSpy).not.toHaveBeenCalled();
  });

  it('no-ops when the installation is gone', async () => {
    const res = await codeGraphIndexService.resolveIndexTarget({
      installationId: 'inst-nope',
      workspaceId: 'ws-gone',
      repoOwner: 'moooon',
      repoName: 'r',
      defaultBranch: 'main',
    });
    expect(res).toEqual({ indexed: false, reason: 'installation_missing' });
  });
});
