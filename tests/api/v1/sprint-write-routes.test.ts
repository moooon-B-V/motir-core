import { beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/v1/projects/[projectKey]/sprints/route';
import { PATCH } from '@/app/api/v1/sprints/[sprintId]/route';
import { GET as GET_ONE } from '@/app/api/v1/sprints/[sprintId]/route';
import { sprintSchema, type V1Sprint } from '@/lib/api/v1/sprints/schema';
import { sprintsService } from '@/lib/services/sprintsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../../fixtures/userFixtures';
import {
  createV1ProjectCaller,
  withTokenFor,
  type V1Caller,
  type V1ProjectCaller,
} from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/projects/{projectKey}/sprints + PATCH /api/v1/sprints/{sprintId}
// (Story 11.3 · Subtask 11.3.5 — MOTIR-2062) against real Postgres.
//
// The assertion that earns its keep here is the DOUBLE gate: a token that
// carries `sprints:write` is still refused when its owner is an ordinary
// member, with a code distinguishable from a missing scope. "My token has the
// scope and I still get 403" is the single most confusing thing this pair can
// do to an integrator.

const BASE = 'http://localhost:3000/api/v1';

function projectParams(projectKey: string): { params: Promise<{ projectKey: string }> } {
  return { params: Promise.resolve({ projectKey }) };
}

function sprintParams(sprintId: string): { params: Promise<{ sprintId: string }> } {
  return { params: Promise.resolve({ sprintId }) };
}

function post(caller: V1Caller, projectKey: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`${BASE}/projects/${projectKey}/sprints`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    projectParams(projectKey),
  );
}

function patch(caller: V1Caller, sprintId: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request(`${BASE}/sprints/${sprintId}`, {
      method: 'PATCH',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    sprintParams(sprintId),
  );
}

async function readBack(caller: V1Caller, sprintId: string): Promise<V1Sprint> {
  const res = await GET_ONE(
    new Request(`${BASE}/sprints/${sprintId}`, { headers: caller.headers }),
    sprintParams(sprintId),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as V1Sprint;
}

/**
 * A caller holding `sprints:write` whose OWNER is an ordinary workspace member,
 * not the owner — the only shape that actually exercises `assertSprintAdmin`.
 * A workspace owner passes that gate, so asserting the refusal as the owner
 * would pass for the wrong reason.
 */
async function nonAdminWriter(caller: V1ProjectCaller): Promise<V1Caller> {
  const user = await createTestUser();
  await workspacesService.addMember({
    userId: user.id,
    workspaceId: caller.workspace.id,
    role: 'member',
  });
  return withTokenFor(user, caller.workspace, { scopes: ['read', 'sprints:write'] });
}

describe('POST /api/v1/projects/{projectKey}/sprints', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('creates a planned sprint, returning 201 + Location + the schema shape', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });

    const res = await post(caller, caller.projectKey, { name: 'Cadence 1', goal: 'ship it' });

    expect(res.status).toBe(201);
    const body = (await res.json()) as V1Sprint;
    expect(res.headers.get('Location')).toBe(`/api/v1/sprints/${body.id}`);
    expect(body.name).toBe('Cadence 1');
    expect(body.goal).toBe('ship it');
    expect(body.state).toBe('planned');
    expect(() => sprintSchema.parse(body)).not.toThrow();
  });

  it("defaults the name to the service's 'Sprint <n>' rather than an empty string", async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });

    const res = await post(caller, caller.projectKey, {});

    expect(res.status).toBe(201);
    expect(((await res.json()) as V1Sprint).name).toBe('Sprint 1');
  });

  it('reads back as never-started: baseline null, not 0', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });

    const created = (await (await post(caller, caller.projectKey, {})).json()) as V1Sprint;
    const readBackSprint = await readBack(caller, created.id);

    expect(readBackSprint.state).toBe('planned');
    expect(readBackSprint.committedIssueCount).toBeNull();
    expect(readBackSprint.committedPoints).toBeNull();
  });

  it('refuses a read-only token with 403 INSUFFICIENT_SCOPE', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await post(caller, caller.projectKey, {});

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('INSUFFICIENT_SCOPE');
  });

  it('refuses a SCOPED token whose owner is not a sprint admin — 403 NOT_SPRINT_ADMIN', async () => {
    // The gate that surprises integrators: the token carries `sprints:write`
    // and is STILL refused, because a scope narrows the owner's role and never
    // widens it (ADR §3). The code must differ from the missing-scope refusal,
    // or the caller re-issues tokens forever against a problem no token fixes.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const member = await nonAdminWriter(caller);

    const res = await post(member, caller.projectKey, {});

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_SPRINT_ADMIN');
  });

  it('surfaces an invalid window as 422 from the SERVICE, not a 500', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });

    const res = await post(caller, caller.projectKey, {
      startDate: '2026-08-10T00:00:00.000Z',
      endDate: '2026-08-01T00:00:00.000Z',
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      code: 'SPRINT_WINDOW_INVALID',
      error: expect.any(String),
    });
  });

  it('surfaces an invalid name as its own typed 422', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });

    const res = await post(caller, caller.projectKey, { name: '   ' });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_SPRINT_NAME');
  });

  it('rejects an unknown body property with 422 rather than silently ignoring it', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });

    const res = await post(caller, caller.projectKey, { nmae: 'typo' });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_BODY');
  });

  it('answers an unknown projectKey with 404, never 403', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });

    const res = await post(caller, 'NOPE', {});

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('PROJECT_NOT_FOUND');
  });
});

describe('PATCH /api/v1/sprints/{sprintId}', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  async function seed(): Promise<{ caller: V1ProjectCaller; sprintId: string }> {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const sprint = await sprintsService.createSprint(
      caller.fixture.projectId,
      { name: 'Original', goal: 'original goal', startDate: '2026-08-01T00:00:00.000Z' },
      caller.ctx,
    );
    return { caller, sprintId: sprint.id };
  }

  it('sets a value', async () => {
    const { caller, sprintId } = await seed();

    const res = await patch(caller, sprintId, { name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(((await res.json()) as V1Sprint).name).toBe('Renamed');
  });

  it('LEAVES a field untouched when its key is ABSENT', async () => {
    // Case 1 of the tri-state. Renaming must not silently clear the goal.
    const { caller, sprintId } = await seed();

    await patch(caller, sprintId, { name: 'Renamed' });

    expect((await readBack(caller, sprintId)).goal).toBe('original goal');
  });

  it('CLEARS a field when the key is explicitly null', async () => {
    // Case 2. Indistinguishable from case 1 if the body were spread.
    const { caller, sprintId } = await seed();

    const res = await patch(caller, sprintId, { goal: null });

    expect(res.status).toBe(200);
    expect(((await res.json()) as V1Sprint).goal).toBeNull();
    expect((await readBack(caller, sprintId)).name).toBe('Original');
  });

  it('CLEARS a date when the key is explicitly null, and leaves it when absent', async () => {
    const { caller, sprintId } = await seed();

    expect((await readBack(caller, sprintId)).startDate).not.toBeNull();
    await patch(caller, sprintId, { goal: 'edited' });
    expect((await readBack(caller, sprintId)).startDate).not.toBeNull();

    await patch(caller, sprintId, { startDate: null });
    expect((await readBack(caller, sprintId)).startDate).toBeNull();
  });

  it('validates the EFFECTIVE window — a patch against the stored dates', async () => {
    const { caller, sprintId } = await seed();

    // `startDate` is 2026-08-01 on the row; an earlier `endDate` alone is still
    // an invalid window, and the SERVICE is what knows that.
    const res = await patch(caller, sprintId, { endDate: '2026-07-01T00:00:00.000Z' });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('SPRINT_WINDOW_INVALID');
  });

  it('refuses a read-only token with 403 INSUFFICIENT_SCOPE', async () => {
    const { sprintId } = await seed();
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await patch(readOnly, sprintId, { name: 'nope' });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('INSUFFICIENT_SCOPE');
  });

  it('refuses a SCOPED token whose owner is not a sprint admin — 403 NOT_SPRINT_ADMIN', async () => {
    const { caller, sprintId } = await seed();
    const member = await nonAdminWriter(caller);

    const res = await patch(member, sprintId, { name: 'nope' });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_SPRINT_ADMIN');
  });

  it("answers ANOTHER tenant's sprint with 404, never 403", async () => {
    const { sprintId } = await seed();
    const other = await createV1ProjectCaller({
      workspaceName: 'Other Co',
      identifier: 'OTHER',
      scopes: ['read', 'sprints:write'],
    });

    const res = await patch(other, sprintId, { name: 'stolen' });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('SPRINT_NOT_FOUND');
  });

  it('answers an unknown sprint id with 404', async () => {
    const { caller } = await seed();

    const res = await patch(caller, 'cmnotasprintid000000000000', { name: 'nope' });

    expect(res.status).toBe(404);
  });
});
