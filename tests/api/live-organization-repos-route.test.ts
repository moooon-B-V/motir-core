import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { POST } from '@/app/api/internal/ai/live-organization-repos/route';
import {
  truncateAuthTables,
  truncateCodeGraphOffboarding,
  truncateRateLimitCounters,
} from '../helpers/db';

// THE CONNECTED-REPOSITORY READ (MOTIR-9137) — real Postgres, the real route.
//
// motir-ai's reconciler subtracts each organisation's `repoRefs` from the code
// graphs it stores for that organisation and removes the difference. So the
// properties below all point one way: a repository missing from this answer is
// a graph deleted, and a list read from the wrong organisation, the wrong
// moment or a failed query is a live tenant's code index gone.

const PASSWORD = 'hunter2hunter2';
const SERVICE_TOKEN = 'test-service-token';
const NO_SUCH_ORG = 'cmzzzzzzzzzz0000zzzzzzzzz';

let previousToken: string | undefined;

beforeAll(() => {
  previousToken = process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'];
  process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'] = SERVICE_TOKEN;
});

afterAll(async () => {
  if (previousToken === undefined) delete process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'];
  else process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'] = previousToken;
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  await truncateCodeGraphOffboarding();
  await truncateRateLimitCounters();
});
afterEach(() => vi.restoreAllMocks());

function request(body: unknown, token: string | null = SERVICE_TOKEN): Request {
  return new Request('http://localhost/api/internal/ai/live-organization-repos', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

interface Verdict {
  coreOrganizationId: string;
  status: string;
  repoRefs: string[];
}

/** An organisation with one workspace and one installation, ready to hold repos. */
async function makeOrg(email: string, name: string) {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspace.id },
  });
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${workspace.id}`,
      workspaceId: workspace.id,
      organizationId,
      accountLogin: name.toLowerCase(),
      accountType: 'Organization',
      provider: 'github',
    },
  });
  async function connect(owner: string, repo: string, provider = 'github') {
    await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: workspace.id,
        organizationId,
        repoId: `host-${owner}-${repo}`,
        owner,
        name: repo,
        defaultBranch: 'main',
        provider,
      },
    });
  }
  return { organizationId, connect };
}

describe('the service-bearer gate', () => {
  it('refuses an unauthenticated call and a wrong bearer', async () => {
    expect((await POST(request({ organizations: [] }, null))).status).toBe(401);
    expect((await POST(request({ organizations: [] }, 'job_abc123'))).status).toBe(401);
  });
});

describe('the per-organisation verdict', () => {
  it('lists every repository connected to a live organisation, any provider', async () => {
    const acme = await makeOrg('a@example.com', 'Acme');
    await acme.connect('motir-co', 'motir-core');
    await acme.connect('motir-co', 'motir-ai');
    await acme.connect('acme-group', 'infra', 'gitlab');

    const res = await POST(
      request({ organizations: [{ coreOrganizationId: acme.organizationId }] }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizations: Verdict[] };
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]!.status).toBe('live');
    expect([...body.organizations[0]!.repoRefs].sort()).toEqual([
      'acme-group/infra',
      'motir-co/motir-ai',
      'motir-co/motir-core',
    ]);
  });

  it('⚠️ reports a renamed owner under its NEW name only — the case this read exists for', async () => {
    // The 2026-10-20 org rename: the installation reconcile re-stamps
    // `github_repo.owner`, and the graph motir-ai built under the old owner is
    // now named by nothing here. That absence is the whole signal.
    const acme = await makeOrg('a@example.com', 'Acme');
    await acme.connect('moooon-B-V', 'motir-core');
    await adminDb.githubRepo.updateMany({
      where: { organizationId: acme.organizationId },
      data: { owner: 'motir-co' },
    });

    const res = await POST(
      request({ organizations: [{ coreOrganizationId: acme.organizationId }] }),
    );

    const body = (await res.json()) as { organizations: Verdict[] };
    expect(body.organizations[0]!.repoRefs).toEqual(['motir-co/motir-core']);
  });

  it('keeps each organisation to its OWN repositories, in the order asked', async () => {
    const acme = await makeOrg('a@example.com', 'Acme');
    const beta = await makeOrg('b@example.com', 'Beta');
    await acme.connect('acme', 'one');
    await beta.connect('beta', 'two');

    const res = await POST(
      request({
        organizations: [
          { coreOrganizationId: beta.organizationId },
          { coreOrganizationId: NO_SUCH_ORG },
          { coreOrganizationId: acme.organizationId },
        ],
      }),
    );

    const body = (await res.json()) as { organizations: Verdict[] };
    expect(body.organizations).toEqual([
      { coreOrganizationId: beta.organizationId, status: 'live', repoRefs: ['beta/two'] },
      { coreOrganizationId: NO_SUCH_ORG, status: 'absent', repoRefs: [] },
      { coreOrganizationId: acme.organizationId, status: 'live', repoRefs: ['acme/one'] },
    ]);
  });

  it('answers a live organisation with nothing connected as live with an empty list', async () => {
    const acme = await makeOrg('a@example.com', 'Acme');

    const res = await POST(
      request({ organizations: [{ coreOrganizationId: acme.organizationId }] }),
    );

    const body = (await res.json()) as { organizations: Verdict[] };
    expect(body.organizations[0]).toEqual({
      coreOrganizationId: acme.organizationId,
      status: 'live',
      repoRefs: [],
    });
  });

  it('an empty list is an empty answer, not an error', async () => {
    const res = await POST(request({ organizations: [] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizations: [] });
  });
});

describe('a database failure aborts rather than reporting empty lists', () => {
  it('propagates as a 500 instead of a 200 with no repositories', async () => {
    // A 200 with `repoRefs: []` tells the consumer every one of the
    // organisation's graphs is orphaned. A failed read must never say that.
    const acme = await makeOrg('a@example.com', 'Acme');
    await acme.connect('acme', 'one');
    vi.spyOn(githubRepoRepository, 'listRefsByOrganizations').mockRejectedValue(
      new Error('db is down'),
    );

    await expect(
      POST(request({ organizations: [{ coreOrganizationId: acme.organizationId }] })),
    ).rejects.toThrow('db is down');
  });
});

describe('the query is parsed strictly, exactly as live-organizations parses it', () => {
  it('rejects a malformed body or entry', async () => {
    expect((await POST(request('not json'))).status).toBe(400);
    expect((await POST(request({}))).status).toBe(400);
    expect((await POST(request({ organizations: [{}] }))).status).toBe(400);
    expect((await POST(request({ organizations: [{ coreOrganizationId: '' }] }))).status).toBe(400);
  });
});
