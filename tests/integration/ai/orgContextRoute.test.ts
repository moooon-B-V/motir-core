import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationsService } from '@/lib/services/organizationsService';
import { mintJobToken } from '@/lib/ai/jobToken';
import { GET as orgContextGET } from '@/app/api/internal/ai/org-context/route';
import { createTestUser, createTestWorkspace, createTestProject } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST — the org-context read-back surface end-to-end through the REAL
// route (Subtask 7.3.45), against a real Postgres. Exercises BOTH auth grants
// (§4a service bearer + §4b job token), the 404-not-403 cross-tenant posture,
// and the footprint summary (org-wide team size + the actor's workspaces /
// projects in the org), mirroring readbackRoutes.test.ts (7.1.8).

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  // organization/workspace/project all CASCADE from the auth-table truncate.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

function orgContextReq(opts: { bearer?: string; token?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request('http://core/api/internal/ai/org-context', { headers });
}

function tokenFor(opts: { userId: string; workspaceId: string; projectId: string }): string {
  return mintJobToken(opts);
}

describe('GET /api/internal/ai/org-context — read-back auth', () => {
  it('rejects a missing/wrong service bearer with 401 service_unauthorized', async () => {
    const noBearer = await orgContextGET(orgContextReq({ token: 'whatever' }));
    expect(noBearer.status).toBe(401);
    expect(await noBearer.json()).toMatchObject({ code: 'service_unauthorized' });

    const badBearer = await orgContextGET(orgContextReq({ bearer: 'nope', token: 'whatever' }));
    expect(badBearer.status).toBe(401);
    expect(await badBearer.json()).toMatchObject({ code: 'service_unauthorized' });
  });

  it('rejects a missing or tampered job token with 401 token_invalid', async () => {
    const missing = await orgContextGET(orgContextReq({ bearer: SERVICE_SECRET }));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ code: 'token_invalid' });

    const tampered = await orgContextGET(
      orgContextReq({ bearer: SERVICE_SECRET, token: 'not.a.real.token' }),
    );
    expect(tampered.status).toBe(401);
    expect(await tampered.json()).toMatchObject({ code: 'token_invalid' });
  });
});

describe('GET /api/internal/ai/org-context — footprint summary', () => {
  it('summarizes the org-wide team size and the actor’s workspaces/projects', async () => {
    // Org with TWO workspaces (owner belongs to both) + THREE projects across
    // them + THREE org members (owner + two added).
    const { workspace: ws1, owner } = await createTestWorkspace({ name: 'Acme' });
    const organizationId = ws1.organizationId;
    const { workspace: ws2 } = await workspacesService.createWorkspace({
      name: 'Beta Labs',
      ownerUserId: owner.id,
      organizationId,
    });

    const alpha = await createTestProject({
      workspaceId: ws1.id,
      actorUserId: owner.id,
      identifier: 'ALPH',
      name: 'Alpha',
    });
    await createTestProject({
      workspaceId: ws1.id,
      actorUserId: owner.id,
      identifier: 'BRAV',
      name: 'Bravo',
    });
    await createTestProject({
      workspaceId: ws2.id,
      actorUserId: owner.id,
      identifier: 'GAMM',
      name: 'Gamma',
    });

    const member1 = await createTestUser();
    const member2 = await createTestUser();
    for (const m of [member1, member2]) {
      await organizationsService.addMember({
        organizationId,
        userId: m.id,
        role: 'member',
        actorUserId: owner.id,
      });
    }

    const token = tokenFor({ userId: owner.id, workspaceId: ws1.id, projectId: alpha.id });
    const res = await orgContextGET(orgContextReq({ bearer: SERVICE_SECRET, token }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.organization).toEqual({ id: organizationId, name: 'Acme' });
    expect(body.workspaceCount).toBe(2);
    expect(body.projectCount).toBe(3);
    expect([...body.projectNames].sort()).toEqual(['Alpha', 'Bravo', 'Gamma']);
    expect(body.memberCount).toBe(3);
    // No slug leaks across the boundary (the AI wire shape is id + name only).
    expect(body.organization).not.toHaveProperty('slug');
  });

  it('reports a fresh org as a zero/one footprint (the no-bias case)', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Solo' });
    const project = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      identifier: 'SOLO',
      name: 'Solo',
    });

    const token = tokenFor({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });
    const res = await orgContextGET(orgContextReq({ bearer: SERVICE_SECRET, token }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.workspaceCount).toBe(1);
    expect(body.projectCount).toBe(1);
    expect(body.memberCount).toBe(1);
  });

  it('404 (not 403) when the token’s user can’t reach the workspace (cross-tenant no-leak)', async () => {
    // A workspace in a DIFFERENT org the token's user has no membership in.
    const { workspace: foreign } = await createTestWorkspace({ name: 'Foreign Org' });
    const stranger = await createTestUser();
    // Give the stranger their OWN workspace so they're a legitimate user, just
    // not a member of `foreign`'s org.
    const { workspace: own } = await createTestWorkspace({ ownerUserId: stranger.id });
    const ownProject = await createTestProject({
      workspaceId: own.id,
      actorUserId: stranger.id,
      identifier: 'OWNX',
      name: 'Own',
    });

    // Token scoped (by a tampered/forged path) to the foreign workspace but the
    // stranger user — resolveWorkspaceAccess denies → 404, never 403.
    const token = tokenFor({
      userId: stranger.id,
      workspaceId: foreign.id,
      projectId: ownProject.id,
    });
    const res = await orgContextGET(orgContextReq({ bearer: SERVICE_SECRET, token }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });
  });
});
