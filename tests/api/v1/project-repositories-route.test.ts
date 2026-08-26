import { randomBytes } from 'node:crypto';
import type { GithubRepo } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { GET } from '@/app/api/v1/projects/[projectKey]/repositories/route';
import {
  presentProjectRepository,
  projectRepositorySchema,
  type V1ProjectRepository,
} from '@/lib/api/v1/projects/repositories';
import { V1_OPERATION_REGISTRY } from '@/lib/api/v1/openapi/registry';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createV1Caller, createV1ProjectCaller, withTokenFor } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/projects/{projectKey}/repositories (Story MOTIR-3584 · Subtask
// MOTIR-3586) against real Postgres — the whole route → service → repository →
// Prisma chain, with a REAL PAT minted through the shipped service.
//
// What this file owns, and why each one is here rather than assumed:
//
//   * THE GRANT. The single caller this endpoint exists for is `motir link`,
//     holding a CLI-minted token. A read gated on a key that grant lacks is an
//     endpoint nobody can call, and that failure is invisible to every test that
//     authenticates as an owner holding everything — so one case mints a token
//     carrying EXACTLY `CLI_TOKEN_GRANT` and asserts a 200.
//   * THE UNESTABLISHED ROW. A `proposed` row must be PRESENT with null
//     coordinates and its own `state`, never omitted: a client materializing the
//     set has to be able to say why a row was skipped.
//   * THE NULL CLONE URL. An ESTABLISHED row whose provider this build cannot
//     address is a second, different null — and the two are only tellable apart
//     by `established` riding beside `cloneUrl`.
//   * SET ORDER. The first row is the project's PRIMARY repository
//     (`docs/decisions/project-repository-set.md` §1.3), so the wire order is
//     part of the answer rather than an incidental.
//   * TENANT ISOLATION, asserted with a real second workspace and a real token
//     bound to it — a 404, indistinguishable from a key that never existed.

const BASE = 'http://localhost:3000/api/v1/projects';

function req(headers: Record<string, string>, key: string, query = ''): Request {
  return new Request(`${BASE}/${key}/repositories${query}`, { headers });
}

function params(projectKey: string): { params: Promise<{ projectKey: string }> } {
  return { params: Promise.resolve({ projectKey }) };
}

interface Page {
  items: V1ProjectRepository[];
  nextCursor: string | null;
}

async function fetchPage(headers: Record<string, string>, key: string, query = ''): Promise<Page> {
  const res = await GET(req(headers, key, query), params(key));
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

/** Connect one repository to the workspace — the installation mirror a set row
 *  realizes against. Mirrors `tests/ready/projectScopedDispatchRepo.test.ts`. */
async function connectRepo(
  workspaceId: string,
  name: string,
  opts: { owner?: string; provider?: string; defaultBranch?: string; archived?: boolean } = {},
): Promise<GithubRepo> {
  const owner = opts.owner ?? 'moooon';
  const provider = opts.provider ?? 'github';
  const installationId = `inst-${workspaceId}-${provider}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
      provider,
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId,
      repoId: `${name}-${randomBytes(6).toString('hex')}`,
      owner,
      name,
      defaultBranch: opts.defaultBranch ?? 'main',
      archived: opts.archived ?? false,
      provider,
    },
  });
}

/** Add a set row and REALIZE it — an `established` row. */
async function establishRepo(
  fx: WorkItemFixture,
  name: string,
  opts: {
    role?: 'web' | 'api' | 'shared';
    provider?: string;
    defaultBranch?: string;
    archived?: boolean;
  } = {},
): Promise<void> {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: opts.role ?? 'web', name },
    fx.ctx,
  );
  const repo = await connectRepo(fx.workspaceId, name, opts);
  await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
}

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET /api/v1/projects/{projectKey}/repositories', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('publishes an established row with everything a client needs to clone it', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await establishRepo(caller.fixture, 'acme-web');

    const page = await fetchPage(caller.headers, caller.projectKey);

    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      role: 'web',
      label: null,
      name: 'acme-web',
      repoRef: 'moooon/acme-web',
      cloneUrl: 'https://github.com/moooon/acme-web.git',
      defaultBranch: 'main',
      archived: false,
      // `connected` — `attachRealizedRepo` is the connect-an-existing path, and
      // it is one of the two ESTABLISHED states, which is what `established`
      // above says without a client having to know the pair.
      state: 'connected',
      established: true,
    });
    // The body IS a schema output, not a shape that merely resembles one.
    expect(() => projectRepositorySchema.parse(page.items[0])).not.toThrow();
  });

  it('keeps an UNESTABLISHED row in the set, with null coordinates and its own state', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await projectRepoSetService.addRow(
      caller.fixture.projectId,
      { role: 'api', name: 'acme-api' },
      caller.fixture.ctx,
    );

    const page = await fetchPage(caller.headers, caller.projectKey);

    // PRESENT, not omitted — the whole point: a client must be able to report a
    // `proposed` row as skipped rather than watch it vanish from the set.
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      role: 'api',
      name: null,
      repoRef: null,
      cloneUrl: null,
      defaultBranch: null,
      archived: false,
      state: 'proposed',
      established: false,
    });
  });

  it('reports the set in ORDER, primary first, across mixed states', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await establishRepo(caller.fixture, 'acme-web', { role: 'web' });
    await establishRepo(caller.fixture, 'acme-shared', { role: 'shared' });
    await projectRepoSetService.addRow(
      caller.fixture.projectId,
      { role: 'api', name: 'acme-api' },
      caller.fixture.ctx,
    );

    const page = await fetchPage(caller.headers, caller.projectKey);

    expect(page.items.map((r) => r.role)).toEqual(['web', 'shared', 'api']);
    expect(page.items.map((r) => r.established)).toEqual([true, true, false]);
  });

  it('clones an ARCHIVED repository and says so — readable is not writable', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await establishRepo(caller.fixture, 'acme-legacy', { archived: true });

    const page = await fetchPage(caller.headers, caller.projectKey);

    // Carried, never filtered on: refusing to BRANCH on an archived repository
    // belongs to dispatch, which refuses by name.
    expect(page.items[0]).toMatchObject({
      archived: true,
      established: true,
      cloneUrl: 'https://github.com/moooon/acme-legacy.git',
    });
  });

  it('publishes the row id a work item’s targetRepositories names', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const row = await projectRepoSetService.addRow(
      caller.fixture.projectId,
      { role: 'web', name: 'acme-web' },
      caller.fixture.ctx,
    );

    const page = await fetchPage(caller.headers, caller.projectKey);

    expect(page.items[0]?.id).toBe(row.id);
  });

  it('breaks a POSITION TIE with the row id, so a cursor can page it soundly', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await establishRepo(caller.fixture, 'acme-web', { role: 'web' });
    await establishRepo(caller.fixture, 'acme-api', { role: 'api' });

    // ⚠️ `position` is a FRACTIONAL INDEX with NO unique constraint, and `moveRow`
    // computes it from a read that guards a write — so two concurrent moves on
    // one project can legitimately land the same key. Ties under a bare
    // `ORDER BY position` come back in an order Postgres does not promise to
    // repeat, and a cursor cannot page soundly over an order that can shuffle.
    // Forced here through the admin client because no service API can produce it
    // on demand, which is exactly why the arm is otherwise unexercised.
    await adminDb.projectRepo.updateMany({
      where: { projectId: caller.fixture.projectId },
      data: { position: 'a0' },
    });

    const page = await fetchPage(caller.headers, caller.projectKey);
    const ids = page.items.map((r) => r.id);

    expect(ids).toHaveLength(2);
    // The tie-break is the row id, ascending — a TOTAL order, so the same two
    // rows come back in the same order on every request.
    expect([...ids].sort()).toEqual(ids);
    expect(await fetchPage(caller.headers, caller.projectKey)).toEqual(page);
  });

  it('pages with a cursor the server issued, over the set’s own order', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await establishRepo(caller.fixture, 'acme-web', { role: 'web' });
    await establishRepo(caller.fixture, 'acme-api', { role: 'api' });

    const first = await fetchPage(caller.headers, caller.projectKey, '?limit=1');
    expect(first.items.map((r) => r.role)).toEqual(['web']);
    expect(first.nextCursor).not.toBeNull();

    const second = await fetchPage(
      caller.headers,
      caller.projectKey,
      `?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect(second.items.map((r) => r.role)).toEqual(['api']);
    expect(second.nextCursor).toBeNull();
  });

  it('refuses a cursor issued for ANOTHER collection with a 422, never a silent reset', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await establishRepo(caller.fixture, 'acme-web');

    // A cursor from the SPRINTS collection: structurally identical (a bare row
    // id) and therefore exactly the confusion the collection scope prevents.
    const { encodeCollectionCursor } = await import('@/lib/api/v1/pagination');
    const foreign = encodeCollectionCursor('sprints', 'some-row-id');

    const res = await GET(
      req(caller.headers, caller.projectKey, `?cursor=${encodeURIComponent(foreign)}`),
      params(caller.projectKey),
    );
    expect(res.status).toBe(422);
  });

  it('answers 200 to a token carrying EXACTLY CLI_TOKEN_GRANT', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await establishRepo(caller.fixture, 'acme-web');

    // The one caller this endpoint is built for. A workspace PAT holding
    // everything would pass whatever key the route declared, which is precisely
    // why this case mints the narrow grant instead.
    const cli = await withTokenFor(caller.fixture.owner, caller.fixture.workspace, {
      permissions: [...CLI_TOKEN_GRANT],
      projectId: caller.fixture.projectId,
    });

    const res = await GET(req(cli.headers, caller.projectKey), params(caller.projectKey));
    expect(res.status).toBe(200);
  });

  it('404s for a project in ANOTHER workspace — no existence leak', async () => {
    const owned = await createV1ProjectCaller({ scopes: ['read'], workspaceName: 'Theirs' });
    await establishRepo(owned.fixture, 'acme-web');
    const stranger = await createV1Caller({ scopes: ['read'], workspaceName: 'Mine' });

    const res = await GET(req(stranger.headers, owned.projectKey), params(owned.projectKey));

    // 404, never 403: a 403 would confirm the key resolves to a real project.
    expect(res.status).toBe(404);
  });

  it('404s for a project key that does not exist anywhere', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await GET(req(caller.headers, 'NOSUCH'), params('NOSUCH'));

    expect(res.status).toBe(404);
  });

  it('returns an empty page — never a 404 — for a project with no set at all', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const page = await fetchPage(caller.headers, caller.projectKey);

    // Every project that predates the repository-set table is in this state, and
    // it is an honest empty answer rather than a missing resource.
    expect(page).toEqual({ items: [], nextCursor: null });
  });
});

describe('presentProjectRepository', () => {
  /** A DTO with only the fields the mapper reads, so the unit stays a unit. */
  function dto(overrides: Partial<ProjectRepoDto> = {}): ProjectRepoDto {
    return {
      id: 'row_1',
      projectId: 'proj_1',
      role: 'web',
      label: null,
      name: 'authored-name',
      seedSource: 'starter',
      state: 'created',
      failureReason: null,
      proposalSignal: null,
      realizedRepo: {
        id: 'gh_1',
        provider: 'github',
        owner: 'moooon',
        name: 'Acme-Web',
        repoRef: 'moooon/Acme-Web',
        defaultBranch: 'main',
        archived: false,
      },
      established: true,
      takeover: null,
      access: { state: 'not_invited', login: null, invitationUrl: null },
      position: 'a0',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      ...overrides,
    } as ProjectRepoDto;
  }

  it('publishes the REALIZED name, not the authored one', () => {
    // The host's own casing is what a checkout directory is named and what a
    // `targetRepo` pin stores; the authored name is an establish-step artifact.
    expect(presentProjectRepository(dto()).name).toBe('Acme-Web');
  });

  it('returns a null cloneUrl for a provider this build cannot address', () => {
    const row = presentProjectRepository(
      dto({
        realizedRepo: {
          id: 'gh_1',
          provider: 'bitbucket',
          owner: 'moooon',
          name: 'acme-web',
          repoRef: 'moooon/acme-web',
          defaultBranch: 'trunk',
          archived: false,
        },
      }),
    );

    // ESTABLISHED and yet un-materializable — the second, different null, and
    // the reason `established` has to ride beside `cloneUrl` on the wire.
    expect(row).toMatchObject({
      established: true,
      defaultBranch: 'trunk',
      cloneUrl: null,
    });
  });

  it('leaks no internal field of the service DTO', () => {
    const shaped = presentProjectRepository(dto({ failureReason: 'boom', seedSource: 'starter' }));

    expect(Object.keys(shaped).sort()).toEqual(
      [
        'archived',
        'cloneUrl',
        'defaultBranch',
        'established',
        'id',
        'label',
        'name',
        'repoRef',
        'role',
        'state',
      ].sort(),
    );
  });
});

describe('the operation declaration', () => {
  it('declares the same permission the route enforces', () => {
    const op = V1_OPERATION_REGISTRY.get('GET /api/v1/projects/{projectKey}/repositories');

    expect(op).toBeDefined();
    expect(op?.operationId).toBe('listProjectRepositories');
    // Documented here, ENFORCED at the route. The drift guard asserts the two
    // agree; this asserts the declared value is the one the grant actually holds.
    expect(op?.permission).toBe('project:browse');
    expect(CLI_TOKEN_GRANT).toContain(op?.permission);
  });
});
