import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';

import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET / PATCH /api/projects/[key]/status-automation — the HTTP surface the
// status-derivation settings panel consumes (Story MOTIR-1615 · Subtask
// MOTIR-1618). Real Postgres; every read/write runs the real route →
// projectStatusAutomationService → projectRepository → Prisma chain (the
// service's own validation + gate semantics are covered in
// `projectStatusAutomation.test.ts`; these tests assert the TRANSPORT contract
// this route owns):
//   * the session gate (401 with no workspace context),
//   * a malformed body → 400,
//   * the partial-patch forwarding — an ABSENT field is untouched, and a
//     present-but-FALSE one is forwarded, not dropped (for a pair of off-switches
//     that is the whole point),
//   * the typed-error → status mapping, incl. the 422 carrying `field`,
//   * the no-existence-leak 404 on an unknown key, and the 403 a non-admin gets.
//
// Only `getWorkspaceContext` is stubbed — the session+active-workspace resolver
// the test env can't supply (no cookies). The mock is PARTIAL (importOriginal),
// so the real `withWorkspaceContext` (the RLS-binding transaction every service
// call depends on) is preserved.

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

// Import the handlers AFTER the mock is registered.
const { GET, PATCH } = await import('@/app/api/projects/[key]/status-automation/route');

const BASE = 'http://localhost:3000/api/projects';

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

function signInAs(fx: WorkItemFixture, userId = fx.ownerId) {
  ctxRef.current = { userId, workspaceId: fx.workspaceId };
}

function routeParams(key: string) {
  return { params: Promise.resolve({ key }) };
}

function get(key: string) {
  return GET(new Request(`${BASE}/${key}/status-automation`), routeParams(key));
}

function patch(key: string, body: unknown, raw?: string) {
  return PATCH(
    new Request(`${BASE}/${key}/status-automation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    }),
    routeParams(key),
  );
}

describe('GET /api/projects/[key]/status-automation', () => {
  it('401 with no workspace context', async () => {
    const res = await get('PROD');
    expect(res.status).toBe(401);
  });

  it('returns both switches, ON by default', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    const res = await get(fx.projectIdentifier);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      autoRollupParentStatus: true,
      autoCompleteChildrenOnParentDone: true,
    });
  });

  it('404s an unknown key (no existence leak)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    const res = await get('NOPE');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/projects/[key]/status-automation', () => {
  it('401 with no workspace context', async () => {
    const res = await patch('PROD', { autoRollupParentStatus: false });
    expect(res.status).toBe(401);
  });

  it('400 on a body that is not JSON', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    const res = await patch(fx.projectIdentifier, undefined, 'not json');
    expect(res.status).toBe(400);
  });

  it('forwards a present-but-FALSE switch and leaves the absent one alone', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    // `false` must survive the route's key-presence filter — a truthiness test
    // here would silently drop every attempt to turn a switch OFF.
    const res = await patch(fx.projectIdentifier, { autoCompleteChildrenOnParentDone: false });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      autoRollupParentStatus: true,
      autoCompleteChildrenOnParentDone: false,
    });
  });

  it('writes both switches when both are supplied', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    const res = await patch(fx.projectIdentifier, {
      autoRollupParentStatus: false,
      autoCompleteChildrenOnParentDone: false,
    });
    expect(res.status).toBe(200);

    const row = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.autoRollupParentStatus).toBe(false);
    expect(row.autoCompleteChildrenOnParentDone).toBe(false);
  });

  it('422 with the offending field on a non-boolean switch', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    const res = await patch(fx.projectIdentifier, { autoRollupParentStatus: 'false' });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      code: 'INVALID_STATUS_AUTOMATION_SETTINGS',
      field: 'autoRollupParentStatus',
    });
  });

  it('403 for a plain workspace member', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const member = await createTestUser({ email: 'member@example.com' });
    await db.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    signInAs(fx, member.id);

    const res = await patch(fx.projectIdentifier, { autoRollupParentStatus: false });
    expect(res.status).toBe(403);
  });

  it('404s an unknown key', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    const res = await patch('NOPE', { autoRollupParentStatus: false });
    expect(res.status).toBe(404);
  });
});
