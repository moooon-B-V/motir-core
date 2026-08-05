import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { LIVE_PROJECTS_MAX_PAIRS } from '@/lib/codeGraph/liveProjects';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { POST } from '@/app/api/internal/ai/live-projects/route';
import { truncateAuthTables, truncateCodeGraphOffboarding } from '../helpers/db';

// THE LIVE-PROJECT READ SEAM (MOTIR-2197 ·
// `docs/decisions/code-graph-index-fleet.md` §14.5) — real Postgres, the real
// route, no DB mocks.
//
// What this endpoint is for is subtraction: motir-ai's offboarding backstop takes
// what it has STORED, removes what this says is LIVE, and deletes the difference.
// Every property below exists because the failure mode points one way — a wrong
// answer here deletes a paying tenant's code index through a path that is working
// exactly as designed.

const PASSWORD = 'hunter2hunter2';
const SERVICE_TOKEN = 'test-service-token';

let previousToken: string | undefined;

beforeAll(() => {
  previousToken = process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'];
  process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'] = SERVICE_TOKEN;
});

afterAll(async () => {
  if (previousToken === undefined) delete process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'];
  else process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'] = previousToken;
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  await truncateCodeGraphOffboarding();
});
afterEach(() => vi.restoreAllMocks());

function request(body: unknown, token: string | null = SERVICE_TOKEN): Request {
  return new Request('http://localhost/api/internal/ai/live-projects', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function makeWorkspace(email: string, name: string) {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  return { owner, workspace };
}

// ── 1. the gate ──────────────────────────────────────────────────────────────

describe('the service-bearer gate', () => {
  it('refuses an unauthenticated call', async () => {
    const res = await POST(request({ projects: [] }, null));
    expect(res.status).toBe(401);
  });

  it('refuses a WRONG bearer — including a plausible job token', async () => {
    // The job-token lane is what fronts every other `/api/internal/ai/*` route,
    // and it must not open this one: those tokens are scoped to ONE planning run's
    // tenant, which is precisely what makes them safe, and this question is
    // cross-tenant by construction.
    for (const token of ['not-the-token', 'job_abc123']) {
      const res = await POST(request({ projects: [] }, token));
      expect(res.status, token).toBe(401);
    }
  });

  it('fails CLOSED when the secret is unset', async () => {
    const saved = process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'];
    delete process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'];
    try {
      const res = await POST(request({ projects: [] }, SERVICE_TOKEN));
      expect(res.status).toBe(401);
    } finally {
      process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'] = saved;
    }
  });
});

// ── 2. the verdicts ──────────────────────────────────────────────────────────

describe('the per-pair verdict', () => {
  it('reports a live project LIVE and a deleted one ABSENT, in the order asked', async () => {
    const { owner, workspace } = await makeWorkspace('a@example.com', 'Acme');
    const live = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    const gone = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Legacy',
    });
    await db.project.delete({ where: { id: gone.id } });

    const res = await POST(
      request({
        projects: [
          { coreWorkspaceId: workspace.id, coreProjectId: gone.id },
          { coreWorkspaceId: workspace.id, coreProjectId: live.id },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: { coreProjectId: string; status: string }[] };
    // Order preserved, so the caller can zip against its own list.
    expect(body.projects.map((p) => [p.coreProjectId, p.status])).toEqual([
      [gone.id, 'absent'],
      [live.id, 'live'],
    ]);
  });

  it('reports a project whose WORKSPACE was deleted as absent', async () => {
    const { owner, workspace } = await makeWorkspace('a@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    await workspacesService.deleteWorkspace({
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const res = await POST(
      request({ projects: [{ coreWorkspaceId: workspace.id, coreProjectId: project.id }] }),
    );

    const body = (await res.json()) as { projects: { status: string }[] };
    expect(body.projects[0]!.status).toBe('absent');
  });

  it('⚠️ reports an ARCHIVED project as LIVE — the archive path owns its own timing', async () => {
    // Treating an archived project as absent would let the BACKSTOP delete its
    // graph immediately, silently overruling the 30-day grace period the archive
    // dialog promises the user (§14.3). The archive already enqueued a windowed
    // removal; this read must not second-guess it.
    const { owner, workspace } = await makeWorkspace('a@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    await projectsService.archiveProject({
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const res = await POST(
      request({ projects: [{ coreWorkspaceId: workspace.id, coreProjectId: project.id }] }),
    );

    const body = (await res.json()) as { projects: { status: string }[] };
    expect(body.projects[0]!.status).toBe('live');
  });

  it('a real project paired with the WRONG workspace is absent, not live', async () => {
    // The workspace id in the query is not redundant with the project id: without
    // it, a caller that mis-paired the two would get a `live` verdict for a
    // tenancy that does not exist.
    const a = await makeWorkspace('a@example.com', 'Acme');
    const b = await makeWorkspace('b@example.com', 'Other');
    const project = await projectsService.createProject({
      workspaceId: a.workspace.id,
      actorUserId: a.owner.id,
      name: 'Core',
    });

    const res = await POST(
      request({ projects: [{ coreWorkspaceId: b.workspace.id, coreProjectId: project.id }] }),
    );

    const body = (await res.json()) as { projects: { status: string }[] };
    expect(body.projects[0]!.status).toBe('absent');
  });

  it('never returns a project the caller did not ask about', async () => {
    // No enumeration. The response is a function of the request, so a leak can
    // never be larger than what the caller already knew.
    const { owner, workspace } = await makeWorkspace('a@example.com', 'Acme');
    const asked = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Unasked',
    });

    const res = await POST(
      request({ projects: [{ coreWorkspaceId: workspace.id, coreProjectId: asked.id }] }),
    );

    const body = (await res.json()) as { projects: { coreProjectId: string }[] };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]!.coreProjectId).toBe(asked.id);
  });

  it('an empty list is an empty answer, not an error', async () => {
    const res = await POST(request({ projects: [] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [] });
  });
});

// ── 3. ⚠️ a failed read is NEVER an "absent" verdict ─────────────────────────

describe('a database failure aborts rather than reporting absence', () => {
  it('propagates as a 500 instead of a 200 full of `absent`', async () => {
    // THE assertion of this card. The consumer subtracts `live` from what it has
    // stored and deletes the difference, so a page of `absent` verdicts produced
    // by a failed query is an instruction to delete every graph in the batch. A
    // 500 aborts the reconciler's run, which is the contract it is written to.
    const { owner, workspace } = await makeWorkspace('a@example.com', 'Acme');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Core',
    });

    vi.spyOn(projectRepository, 'findLivePairs').mockRejectedValue(new Error('db is down'));

    await expect(
      POST(request({ projects: [{ coreWorkspaceId: workspace.id, coreProjectId: project.id }] })),
    ).rejects.toThrow('db is down');
  });
});

// ── 4. the request shape ─────────────────────────────────────────────────────

describe('the query is parsed strictly', () => {
  it('rejects a non-JSON body, a non-object body, and a missing projects array', async () => {
    expect((await POST(request('not json'))).status).toBe(400);
    // Valid JSON that is not an object — `[]`, a bare string, `null`. These parse
    // fine and would read as "no pairs" if the shape were not checked, which for
    // this endpoint means answering a question nobody asked.
    expect((await POST(request([]))).status).toBe(400);
    expect((await POST(request('"a string"'))).status).toBe(400);
    expect((await POST(request('null'))).status).toBe(400);
    expect((await POST(request({}))).status).toBe(400);
    expect((await POST(request({ projects: 'nope' }))).status).toBe(400);
  });

  it('rejects a malformed PAIR rather than silently skipping it', async () => {
    // A dropped pair would come back with no verdict at all, and a caller
    // iterating its own list against a shorter response is exactly how an
    // off-by-one becomes a wrong deletion.
    for (const projects of [
      [{ coreProjectId: 'p1' }],
      [{ coreWorkspaceId: 'w1' }],
      [{ coreWorkspaceId: 'w1', coreProjectId: '' }],
      [{ coreWorkspaceId: 'w1', coreProjectId: 'p1' }, null],
    ]) {
      const res = await POST(request({ projects }));
      expect(res.status, JSON.stringify(projects)).toBe(400);
    }
  });

  it('bounds how many pairs one call may ask about', async () => {
    const projects = Array.from({ length: LIVE_PROJECTS_MAX_PAIRS + 1 }, (_, i) => ({
      coreWorkspaceId: 'w1',
      coreProjectId: `p${i}`,
    }));
    const res = await POST(request({ projects }));
    expect(res.status).toBe(400);
  });

  it('accepts exactly the maximum', async () => {
    const projects = Array.from({ length: LIVE_PROJECTS_MAX_PAIRS }, (_, i) => ({
      coreWorkspaceId: 'w1',
      coreProjectId: `p${i}`,
    }));
    const res = await POST(request({ projects }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: { status: string }[] };
    expect(body.projects).toHaveLength(LIVE_PROJECTS_MAX_PAIRS);
    expect(body.projects.every((p) => p.status === 'absent')).toBe(true);
  });
});
