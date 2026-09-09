import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { LIVE_ORGANIZATIONS_MAX_IDS } from '@/lib/codeGraph/liveOrganizations';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { POST } from '@/app/api/internal/ai/live-organizations/route';
import { POST as POST_LIVE_PROJECTS } from '@/app/api/internal/ai/live-projects/route';
import { truncateAuthTables, truncateCodeGraphOffboarding } from '../helpers/db';

// THE LIVE-ORGANISATION READ SEAM (MOTIR-4647 · MOTIR-4642) — real Postgres, the
// real route, no DB mocks.
//
// What this endpoint is for is subtraction: motir-ai's code-graph reconciler
// takes what it has STORED, removes what this says is LIVE, and deletes the
// difference. Every property below exists because the failure mode points one
// way — a wrong answer here deletes a paying tenant's code index through a path
// that is working exactly as designed.
//
// ⚠️ THE ORG-TIER INVERSION IS THE POINT OF THE CARD. The project-shaped read
// asserts a parent hop (a project whose workspace is gone is absent). An
// organisation is the ROOT tier, so the same instinct applied here — "check it
// has something under it" — reports a real, empty, paid-for organisation as
// absent and deletes its graphs. The zero-workspaces test below is that case.

const PASSWORD = 'hunter2hunter2';
const SERVICE_TOKEN = 'test-service-token';
/** Syntactically fine, names no row — the confirmed-absent coordinate. */
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
});
afterEach(() => vi.restoreAllMocks());

function request(body: unknown, token: string | null = SERVICE_TOKEN): Request {
  return new Request('http://localhost/api/internal/ai/live-organizations', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** An organisation with NOTHING under it — no workspace, no project. */
async function makeEmptyOrg(email: string, name: string) {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const org = await organizationsService.createOrganization({ name, actorUserId: owner.id });
  return { owner, org };
}

// ── 1. the gate ──────────────────────────────────────────────────────────────

describe('the service-bearer gate', () => {
  it('refuses an unauthenticated call', async () => {
    const res = await POST(request({ organizations: [] }, null));
    expect(res.status).toBe(401);
  });

  it('refuses a WRONG bearer — including a plausible job token', async () => {
    // The job-token lane is what fronts every other `/api/internal/ai/*` route,
    // and it must not open this one: those tokens are scoped to ONE planning
    // run's tenant, which is precisely what makes them safe, and this question
    // is cross-tenant by construction.
    for (const token of ['not-the-token', 'job_abc123']) {
      const res = await POST(request({ organizations: [] }, token));
      expect(res.status, token).toBe(401);
    }
  });

  it('fails CLOSED when the secret is unset', async () => {
    const saved = process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'];
    delete process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'];
    try {
      const res = await POST(request({ organizations: [] }, SERVICE_TOKEN));
      expect(res.status).toBe(401);
    } finally {
      process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'] = saved;
    }
  });
});

// ── 2. the verdicts ──────────────────────────────────────────────────────────

describe('the per-organisation verdict', () => {
  it('⚠️ reports an organisation with ZERO workspaces and ZERO projects as LIVE', async () => {
    // THE assertion of this card, and the one the project-shaped route gets
    // wrong by construction. An organisation is live because its own row is
    // there — a fresh org that nobody has put a workspace in yet is a customer
    // who signed up this morning, not a tenant to garbage-collect. Any parent /
    // child hop copied over from `findLivePairs` fails exactly here.
    const { org } = await makeEmptyOrg('empty@example.com', 'Empty Co');

    const workspaces = await adminDb.workspace.count({ where: { organizationId: org.id } });
    expect(workspaces, 'fixture must have no workspaces to be meaningful').toBe(0);

    const res = await POST(request({ organizations: [{ coreOrganizationId: org.id }] }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizations: { status: string }[] };
    expect(body.organizations[0]!.status).toBe('live');
  });

  it('reports a live organisation LIVE and a deleted one ABSENT, in the order asked', async () => {
    const live = await makeEmptyOrg('a@example.com', 'Acme');
    const gone = await makeEmptyOrg('b@example.com', 'Legacy');
    await adminDb.organization.delete({ where: { id: gone.org.id } });

    const res = await POST(
      request({
        organizations: [
          { coreOrganizationId: gone.org.id },
          { coreOrganizationId: NO_SUCH_ORG },
          { coreOrganizationId: live.org.id },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organizations: { coreOrganizationId: string; status: string }[];
    };
    // Order preserved, so the caller can zip against its own list. First and
    // last differ, which is what makes an order bug visible at all.
    expect(body.organizations.map((o) => [o.coreOrganizationId, o.status])).toEqual([
      [gone.org.id, 'absent'],
      [NO_SUCH_ORG, 'absent'],
      [live.org.id, 'live'],
    ]);
  });

  it('reports an organisation id that names no row as absent', async () => {
    const res = await POST(request({ organizations: [{ coreOrganizationId: NO_SUCH_ORG }] }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizations: { status: string }[] };
    expect(body.organizations[0]!.status).toBe('absent');
  });

  it('reports an organisation whose WORKSPACE was deleted as still LIVE', async () => {
    // The mirror of the project route's workspace-deleted test, and it answers
    // the OPPOSITE way on purpose: deleting a workspace ends a workspace, not
    // the organisation that owns it. The org keeps its graphs.
    const owner = await usersService.createUser({
      email: 'c@example.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const row = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    await workspacesService.deleteWorkspace({ workspaceId: workspace.id, actorUserId: owner.id });

    const res = await POST(
      request({ organizations: [{ coreOrganizationId: row.organizationId }] }),
    );

    const body = (await res.json()) as { organizations: { status: string }[] };
    expect(body.organizations[0]!.status).toBe('live');
  });

  it('never returns an organisation the caller did not ask about', async () => {
    // No enumeration. The response is a function of the request, so a leak can
    // never be larger than what the caller already knew.
    const asked = await makeEmptyOrg('a@example.com', 'Asked Co');
    await makeEmptyOrg('b@example.com', 'Unasked Co');

    const res = await POST(request({ organizations: [{ coreOrganizationId: asked.org.id }] }));

    const body = (await res.json()) as { organizations: { coreOrganizationId: string }[] };
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]!.coreOrganizationId).toBe(asked.org.id);
  });

  it('an empty list is an empty answer, not an error', async () => {
    const res = await POST(request({ organizations: [] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizations: [] });
  });
});

// ── 3. ⚠️ a failed read is NEVER an "absent" verdict ─────────────────────────

describe('a database failure aborts rather than reporting absence', () => {
  it('propagates as a 500 instead of a 200 full of `absent`', async () => {
    // THE safety assertion. The consumer subtracts `live` from what it has
    // stored and deletes the difference, so a page of `absent` verdicts produced
    // by a failed query is an instruction to delete every graph in the batch. A
    // 500 aborts the reconciler's run, which is the contract it is written to.
    const { org } = await makeEmptyOrg('a@example.com', 'Acme');

    vi.spyOn(organizationRepository, 'findLiveIds').mockRejectedValue(new Error('db is down'));

    await expect(
      POST(request({ organizations: [{ coreOrganizationId: org.id }] })),
    ).rejects.toThrow('db is down');
  });
});

// ── 4. the request shape ─────────────────────────────────────────────────────

describe('the query is parsed strictly', () => {
  it('rejects a non-JSON body, a non-object body, and a missing organizations array', async () => {
    expect((await POST(request('not json'))).status).toBe(400);
    // Valid JSON that is not an object — `[]`, a bare string, `null`. These
    // parse fine and would read as "no organisations" if the shape were not
    // checked, which for this endpoint means answering a question nobody asked.
    expect((await POST(request([]))).status).toBe(400);
    expect((await POST(request('"a string"'))).status).toBe(400);
    expect((await POST(request('null'))).status).toBe(400);
    expect((await POST(request({}))).status).toBe(400);
    expect((await POST(request({ organizations: 'nope' }))).status).toBe(400);
  });

  it('rejects a malformed ENTRY rather than silently skipping it', async () => {
    // A dropped entry would come back with no verdict at all, and a caller
    // iterating its own list against a shorter response is exactly how an
    // off-by-one becomes a wrong deletion.
    for (const organizations of [
      [{}],
      [{ coreOrganizationId: '' }],
      [{ coreOrganizationId: 7 }],
      [{ coreOrganizationId: 'o1' }, null],
    ]) {
      const res = await POST(request({ organizations }));
      expect(res.status, JSON.stringify(organizations)).toBe(400);
    }
  });

  it('bounds how many organisations one call may ask about', async () => {
    const organizations = Array.from({ length: LIVE_ORGANIZATIONS_MAX_IDS + 1 }, (_, i) => ({
      coreOrganizationId: `o${i}`,
    }));
    const res = await POST(request({ organizations }));
    expect(res.status).toBe(400);
  });

  it('accepts exactly the maximum', async () => {
    const organizations = Array.from({ length: LIVE_ORGANIZATIONS_MAX_IDS }, (_, i) => ({
      coreOrganizationId: `o${i}`,
    }));
    const res = await POST(request({ organizations }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizations: { status: string }[] };
    expect(body.organizations).toHaveLength(LIVE_ORGANIZATIONS_MAX_IDS);
    expect(body.organizations.every((o) => o.status === 'absent')).toBe(true);
  });
});

// ── 5. the two liveness routes answer ONE contract ───────────────────────────

describe('the org read and the project read cannot drift apart', () => {
  it('answers the same verdict vocabulary, one per input, in input order', async () => {
    // The card's last criterion, asserted STRUCTURALLY rather than by a comment
    // saying the shapes match. motir-ai's reconciler switches on one verdict
    // union for both reads, so the day one route grows a fourth status or starts
    // compacting its response, this fails rather than being noticed in
    // production by a deletion.
    const owner = await usersService.createUser({
      email: 'z@example.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    const row = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });

    const orgRes = await POST(
      request({
        organizations: [
          { coreOrganizationId: NO_SUCH_ORG },
          { coreOrganizationId: row.organizationId },
        ],
      }),
    );
    const projectRes = await POST_LIVE_PROJECTS(
      new Request('http://localhost/api/internal/ai/live-projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_TOKEN}` },
        body: JSON.stringify({
          projects: [
            { coreWorkspaceId: workspace.id, coreProjectId: 'cmzzzzzzzzzz0000zzzzzzzzy' },
            { coreWorkspaceId: workspace.id, coreProjectId: project.id },
          ],
        }),
      }),
    );

    expect(orgRes.status).toBe(200);
    expect(projectRes.status).toBe(200);

    const orgBody = (await orgRes.json()) as { organizations: { status: string }[] };
    const projectBody = (await projectRes.json()) as { projects: { status: string }[] };

    // Same three-valued vocabulary, drawn from the same union.
    const VERDICTS = ['live', 'absent', 'unknown'];
    for (const verdict of [...orgBody.organizations, ...projectBody.projects]) {
      expect(VERDICTS).toContain(verdict.status);
    }
    // One verdict per input, and the same absent-then-live ordering from both.
    expect(orgBody.organizations.map((o) => o.status)).toEqual(['absent', 'live']);
    expect(projectBody.projects.map((p) => p.status)).toEqual(['absent', 'live']);
  });
});
