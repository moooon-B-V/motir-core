import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// PATCH /api/projects/[key]/access and GET …/access/preview (Story MOTIR-6169 ·
// MOTIR-6544) through the shipped route handlers. The session is the one thing
// stubbed — a route test has no cookie jar — so the context resolver hands back
// the actor and the 2FA hold lets them through. Everything after it is real.

const { getWorkspaceContext, refuseIfNonCompliant } = vi.hoisted(() => ({
  getWorkspaceContext: vi.fn(),
  refuseIfNonCompliant: vi.fn(async () => null),
}));
vi.mock('@/lib/workspaces', async (orig) => ({
  ...(await orig<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext,
}));
vi.mock('@/lib/auth/requireCompliantSession', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/requireCompliantSession')>()),
  refuseIfNonCompliant,
}));

beforeEach(async () => {
  await truncateAuthTables();
  getWorkspaceContext.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function fixture(slug: string) {
  const owner = await usersService.createUser({
    email: `owner-${slug}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const plain = await usersService.createUser({
    email: `plain-${slug}@example.com`,
    password: 'hunter2hunter2',
    name: 'Plain',
  });
  await workspacesService.addMember({
    userId: plain.id,
    workspaceId: workspace.id,
    workspaceRole: 'member',
  });
  const as = (userId: string) =>
    getWorkspaceContext.mockResolvedValue({ userId, workspaceId: workspace.id });
  return { owner, plain, workspace, project, key: project.identifier, as };
}

const params = (key: string) => ({ params: Promise.resolve({ key }) });

async function patch(key: string, body: unknown) {
  const { PATCH } = await import('@/app/api/projects/[key]/access/route');
  return PATCH(
    new Request(`http://localhost/api/projects/${key}/access`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(key),
  );
}

async function preview(key: string, mode?: string) {
  const { GET } = await import('@/app/api/projects/[key]/access/preview/route');
  const q = mode ? `?mode=${mode}` : '';
  return GET(new Request(`http://localhost/api/projects/${key}/access/preview${q}`), params(key));
}

describe('PATCH /api/projects/[key]/access', () => {
  it('{ accessMode: members } by a Manager lands at members / private with the same membership rows', async () => {
    const f = await fixture('route-members');
    f.as(f.owner.id);
    const before = await adminDb.projectMembership.count({ where: { projectId: f.project.id } });
    const res = await patch(f.key, { accessMode: 'members' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      access: { key: f.key, accessMode: 'members', accessLevel: 'private' },
    });
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: f.project.id } });
    expect([row.accessMode, row.accessLevel]).toEqual(['members', 'private']);
    expect(await adminDb.projectMembership.count({ where: { projectId: f.project.id } })).toBe(
      before,
    );
  });

  it('still accepts the legacy { accessLevel: limited } and lands it at members', async () => {
    const f = await fixture('route-legacy');
    f.as(f.owner.id);
    const res = await patch(f.key, { accessLevel: 'limited' });
    expect(res.status).toBe(200);
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: f.project.id } });
    expect(row.accessMode).toBe('members');
  });

  it('refuses an unknown mode, a body with both fields, and a body with neither — 400', async () => {
    const f = await fixture('route-bad');
    f.as(f.owner.id);
    expect((await patch(f.key, { accessMode: 'x' })).status).toBe(400);
    const both = await patch(f.key, { accessMode: 'members', accessLevel: 'private' });
    expect(both.status).toBe(400);
    expect((await patch(f.key, {})).status).toBe(400);
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: f.project.id } });
    expect(row.accessMode).toBe('workspace');
  });

  it('a workspace Member gets 403 and changes nothing', async () => {
    const f = await fixture('route-member');
    f.as(f.plain.id);
    const res = await patch(f.key, { accessMode: 'members' });
    expect(res.status).toBe(403);
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: f.project.id } });
    expect(row.accessMode).toBe('workspace');
  });

  it('refuses `public` on a self-hosted build with the cloud-only 400', async () => {
    const f = await fixture('route-public');
    f.as(f.owner.id);
    const res = await patch(f.key, { accessMode: 'public' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('PUBLIC_ACCESS_UNAVAILABLE');
  });
});

describe('GET /api/projects/[key]/access/preview', () => {
  it('names the Full, non-Manager members not added for `members`, and nobody for `workspace`', async () => {
    const f = await fixture('route-preview');
    f.as(f.owner.id);
    const members = await preview(f.key, 'members');
    expect(members.status).toBe(200);
    const { losing } = (await members.json()) as { losing: Array<{ userId: string }> };
    expect(losing.map((p) => p.userId)).toEqual([f.plain.id]);
    const workspace = await preview(f.key, 'workspace');
    expect(await workspace.json()).toEqual({ losing: [] });
  });

  it('requires a mode, and is 403 for a Member', async () => {
    const f = await fixture('route-preview-refused');
    f.as(f.owner.id);
    expect((await preview(f.key)).status).toBe(400);
    f.as(f.plain.id);
    expect((await preview(f.key, 'members')).status).toBe(403);
  });

  it('401 with no session, the 2FA hold answered as-is, and an unknown fault rethrown', async () => {
    const f = await fixture('route-preview-edges');
    getWorkspaceContext.mockResolvedValue(null);
    expect((await preview(f.key, 'members')).status).toBe(401);

    f.as(f.owner.id);
    refuseIfNonCompliant.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'TWO_FACTOR_REQUIRED' }), { status: 403 }) as never,
    );
    expect((await preview(f.key, 'members')).status).toBe(403);

    const { projectMembersService } = await import('@/lib/services/projectMembersService');
    const spy = vi
      .spyOn(projectMembersService, 'previewAccessModeChange')
      .mockRejectedValueOnce(new Error('the database went away'));
    await expect(preview(f.key, 'members')).rejects.toThrow('the database went away');
    spy.mockRestore();
  });
});

describe('projectMembersService.getPageCapabilities — what the Access & members page offers (MOTIR-6550)', () => {
  it('a Manager may manage both the mode and the people; a plain Member neither', async () => {
    const { projectMembersService } = await import('@/lib/services/projectMembersService');
    const f = await fixture('caps');
    const at = (userId: string) => ({
      key: f.key,
      actorUserId: userId,
      ctx: { userId, workspaceId: f.workspace.id },
    });
    expect(await projectMembersService.getPageCapabilities(at(f.owner.id))).toEqual({
      canManageAccess: true,
      canManageMembers: true,
    });
    expect(await projectMembersService.getPageCapabilities(at(f.plain.id))).toEqual({
      canManageAccess: false,
      canManageMembers: false,
    });
  });
});
