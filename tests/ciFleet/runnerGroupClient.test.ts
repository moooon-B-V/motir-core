import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUNNER_GROUP_TEMPLATE,
  RunnerGroupApiError,
  runnerGroupClient,
  runnerGroupNameFor,
} from '@/lib/github/runnerGroups';
import {
  RepoProvisioningNotConfiguredError,
  _resetProvisioningInstallationCache,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// The runner-GROUP boundary itself (Story MOTIR-1916 · MOTIR-1972) — the HTTP
// mechanics, at the level the service above it cannot reach.
//
// `projectRunnerGroupService.test.ts` drives this client through the real
// establish flow and asserts what a project ENDS UP with. This file covers the
// wire: which body each call sends, and what each REFUSAL shape does — a 404
// that means "gone" versus one that means "failed", a body that is not JSON, a
// payload whose id is missing, a list that spans more than one page. Those
// branches decide whether a group is re-created, adopted, or silently lost, and
// none of them is reachable through a happy-path fake.
//
// No database: this module has none. The only fake is `fetch`.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let handler: (call: Call) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A request the runner-group client made that is NOT the auth handshake. */
function groupCalls(): Call[] {
  return calls.filter((c) => c.url.includes('/actions/runner-groups'));
}

beforeEach(() => {
  calls = [];
  handler = () => json(200, {});
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      if (call.url.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (call.url.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return handler(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the name is deterministic', () => {
  it('is derived from the project id, so an orphan is attributable', () => {
    expect(runnerGroupNameFor('cabc123')).toBe('motir-project-cabc123');
  });
});

describe('createGroup', () => {
  it('sends the template shape verbatim — selected, never public-fork-visible', async () => {
    handler = () => json(201, { id: 77, name: 'motir-project-p1', visibility: 'selected' });

    const group = await runnerGroupClient.createGroup({
      name: 'motir-project-p1',
      selectedRepositoryIds: [11, 22],
    });

    expect(group).toMatchObject({ id: 77, name: 'motir-project-p1', visibility: 'selected' });
    const create = groupCalls()[0]!;
    expect(create.method).toBe('POST');
    expect(create.body).toEqual({
      name: 'motir-project-p1',
      visibility: RUNNER_GROUP_TEMPLATE.visibility,
      allows_public_repositories: RUNNER_GROUP_TEMPLATE.allowsPublicRepositories,
      restricted_to_workflows: RUNNER_GROUP_TEMPLATE.restrictedToWorkflows,
      selected_repository_ids: [11, 22],
    });
    // The measured template (`motir-project-template`, id 104) — a console
    // template and a programmatic path that differ is a silent divergence.
    expect(RUNNER_GROUP_TEMPLATE).toEqual({
      visibility: 'selected',
      allowsPublicRepositories: false,
      restrictedToWorkflows: false,
    });
  });

  it('accepts a STRING id, because GitHub is not consistent about that', async () => {
    handler = () => json(201, { id: '88', name: 'g', allows_public_repositories: false });
    await expect(
      runnerGroupClient.createGroup({ name: 'g', selectedRepositoryIds: [] }),
    ).resolves.toMatchObject({ id: 88, allowsPublicRepositories: false });
  });

  it('throws the typed error on a refusal, carrying the status and no raw body', async () => {
    handler = () => json(403, { message: 'Resource not accessible by integration', extra: 'x' });

    const err = await runnerGroupClient
      .createGroup({ name: 'g', selectedRepositoryIds: [] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RunnerGroupApiError);
    expect((err as RunnerGroupApiError).status).toBe(403);
    expect((err as Error).message).toContain('403');
    expect((err as Error).message).toContain('Resource not accessible');
    expect((err as Error).message).not.toContain('extra');
  });

  it('throws when the 201 body carries no usable id', async () => {
    handler = () => json(201, { name: 'g' });
    await expect(
      runnerGroupClient.createGroup({ name: 'g', selectedRepositoryIds: [] }),
    ).rejects.toThrow(/unexpected shape/);
  });

  it('reports a non-JSON error body by STATUS rather than choking on it', async () => {
    handler = () => new Response('<html>502</html>', { status: 502 });
    const err = await runnerGroupClient
      .createGroup({ name: 'g', selectedRepositoryIds: [] })
      .catch((e: unknown) => e);
    expect((err as RunnerGroupApiError).status).toBe(502);
  });

  it('normalizes a transport failure to the typed error with a null status', async () => {
    handler = () => {
      throw new TypeError('fetch failed');
    };
    const err = await runnerGroupClient
      .createGroup({ name: 'g', selectedRepositoryIds: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerGroupApiError);
    expect((err as RunnerGroupApiError).status).toBeNull();
    expect((err as Error).message).toContain('could not be reached');
  });
});

describe('getGroup', () => {
  it('returns the group', async () => {
    handler = () =>
      json(200, { id: 5, name: 'g', visibility: 'selected', allows_public_repositories: false });
    await expect(runnerGroupClient.getGroup(5)).resolves.toMatchObject({ id: 5, name: 'g' });
  });

  it('returns NULL on 404 — the self-healing signal, not a failure', async () => {
    // This is the branch that decides whether a group deleted out of band is
    // re-created or the whole sync is abandoned.
    handler = () => json(404, { message: 'Not Found' });
    await expect(runnerGroupClient.getGroup(5)).resolves.toBeNull();
  });

  it('still throws on any OTHER refusal', async () => {
    handler = () => json(500, { message: 'boom' });
    await expect(runnerGroupClient.getGroup(5)).rejects.toBeInstanceOf(RunnerGroupApiError);
  });

  it('throws when a 200 body is not a group', async () => {
    handler = () => json(200, { name: 'no id here' });
    await expect(runnerGroupClient.getGroup(5)).rejects.toThrow(/unexpected shape/);
  });
});

describe('findGroupByName', () => {
  it('matches case-insensitively — GitHub does not distinguish two groups by case', async () => {
    handler = () => json(200, { runner_groups: [{ id: 9, name: 'Motir-Project-P1' }] });
    await expect(runnerGroupClient.findGroupByName('motir-project-p1')).resolves.toMatchObject({
      id: 9,
    });
  });

  it('returns null when no group matches', async () => {
    handler = () => json(200, { runner_groups: [{ id: 9, name: 'something-else' }] });
    await expect(runnerGroupClient.findGroupByName('motir-project-p1')).resolves.toBeNull();
  });

  it('walks PAGES — the org may hold far more groups than one page', async () => {
    // §7.3's named unknown is the groups-per-org ceiling; MOTIR-1919 measured it
    // to at least 102, so a single-page lookup would miss real groups and make a
    // duplicate.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `other-${i}` }));
    handler = (call) => {
      const page = new URL(call.url).searchParams.get('page');
      if (page === '1') return json(200, { runner_groups: page1 });
      return json(200, { runner_groups: [{ id: 4242, name: 'motir-project-p1' }] });
    };
    await expect(runnerGroupClient.findGroupByName('motir-project-p1')).resolves.toMatchObject({
      id: 4242,
    });
    expect(groupCalls()).toHaveLength(2);
  });

  it('tolerates a page whose entries are not groups', async () => {
    handler = () => json(200, { runner_groups: ['nonsense', { name: 'no id' }, null] });
    await expect(runnerGroupClient.findGroupByName('x')).resolves.toBeNull();
  });

  it('tolerates a body with no list at all', async () => {
    handler = () => json(200, { total_count: 0 });
    await expect(runnerGroupClient.findGroupByName('x')).resolves.toBeNull();
  });

  it('throws on a refusal rather than reporting "no such group"', async () => {
    // A refusal read as "not found" would create a SECOND group for a project
    // that already has one — the exact duplicate the adopt path prevents.
    handler = () => json(401, { message: 'Bad credentials' });
    await expect(runnerGroupClient.findGroupByName('x')).rejects.toBeInstanceOf(
      RunnerGroupApiError,
    );
  });
});

describe('setGroupRepositories', () => {
  it('PUTs the WHOLE array, so the desired state is what lands', async () => {
    handler = () => new Response(null, { status: 204 });
    await runnerGroupClient.setGroupRepositories(7, [1, 2, 3]);
    const put = groupCalls()[0]!;
    expect(put.method).toBe('PUT');
    expect(put.url).toContain('/runner-groups/7/repositories');
    expect(put.body).toEqual({ selected_repository_ids: [1, 2, 3] });
  });

  it('accepts an EMPTY array — a project whose repos have all been handed over', async () => {
    handler = () => new Response(null, { status: 204 });
    await runnerGroupClient.setGroupRepositories(7, []);
    expect(groupCalls()[0]!.body).toEqual({ selected_repository_ids: [] });
  });

  it('throws the typed error on a refusal', async () => {
    handler = () => json(422, { message: 'Repository not in organization' });
    await expect(runnerGroupClient.setGroupRepositories(7, [1])).rejects.toBeInstanceOf(
      RunnerGroupApiError,
    );
  });
});

describe('deleteGroup', () => {
  it('deletes', async () => {
    handler = () => new Response(null, { status: 204 });
    await runnerGroupClient.deleteGroup(7);
    expect(groupCalls()[0]).toMatchObject({ method: 'DELETE' });
  });

  it('is IDEMPOTENT against an already-deleted group', async () => {
    // The delete runs from a handoff saga and a project deletion, either of which
    // may be retried; a 404 is the desired end state reached by someone else.
    handler = () => json(404, { message: 'Not Found' });
    await expect(runnerGroupClient.deleteGroup(7)).resolves.toBeUndefined();
  });

  it('throws on a real refusal so the caller keeps the id and can retry', async () => {
    handler = () => json(503, { message: 'unavailable' });
    await expect(runnerGroupClient.deleteGroup(7)).rejects.toBeInstanceOf(RunnerGroupApiError);
  });
});

describe('an unwired deployment', () => {
  it('cannot reach the flow at all — the typed not-configured error, never a crash', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    await expect(runnerGroupClient.getGroup(1)).rejects.toBeInstanceOf(
      RepoProvisioningNotConfiguredError,
    );
  });
});
