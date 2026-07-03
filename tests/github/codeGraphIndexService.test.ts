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
// boundary. Asserts the tarball is fetched ONCE and handed to motir-ai once per
// project with the right tenant tuple (the workspace→projects fan-out).

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

describe('codeGraphIndexService.indexRepoIntoWorkspaceProjects', () => {
  it('fetches the tarball once and indexes it into every project of the workspace', async () => {
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
      repos: [{ providerRepoId: '555', owner: 'moooon', name: 'acme', defaultBranch: 'main' }],
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

    const res = await codeGraphIndexService.indexRepoIntoWorkspaceProjects({
      installationId: 'inst-cg',
      repoOwner: 'moooon',
      repoName: 'acme',
      defaultBranch: 'main',
    });

    expect(res).toEqual({ indexed: true, repoRef: 'moooon/acme', projectsIndexed: 2 });

    // The tarball was fetched exactly once (reused across projects).
    const tarballFetches = fetchMock.mock.calls.filter(([u]) => String(u).includes('/tarball/'));
    expect(tarballFetches).toHaveLength(1);

    // One motir-ai call per project, each with the workspace's org + the SAME bytes.
    expect(indexSpy).toHaveBeenCalledTimes(2);
    const projectIds = indexSpy.mock.calls.map(([arg]) => arg.coreProjectId).sort();
    expect(projectIds).toEqual([projectA.id, projectB.id].sort());
    for (const [arg] of indexSpy.mock.calls) {
      expect(arg.coreOrganizationId).toBe(workspace.organizationId);
      expect(arg.coreWorkspaceId).toBe(workspace.id);
      expect(arg.repoRef).toBe('moooon/acme');
      expect(new Uint8Array(arg.bytes as ArrayBuffer)).toEqual(TARBALL);
    }
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
      repos: [{ providerRepoId: '1', owner: 'moooon', name: 'r', defaultBranch: 'main' }],
    });

    // Auto-created workspaces may seed a default project; remove any so the
    // "no projects" branch is exercised deterministically.
    await db.project.deleteMany({ where: { workspaceId: workspace.id } });

    const fetchMock = stubGithubTarball();
    const indexSpy = vi.spyOn(motirAiClient, 'indexCodeGraph');

    const res = await codeGraphIndexService.indexRepoIntoWorkspaceProjects({
      installationId: 'inst-empty',
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
    const res = await codeGraphIndexService.indexRepoIntoWorkspaceProjects({
      installationId: 'inst-nope',
      repoOwner: 'moooon',
      repoName: 'r',
      defaultBranch: 'main',
    });
    expect(res).toEqual({ indexed: false, reason: 'installation_missing' });
  });
});
