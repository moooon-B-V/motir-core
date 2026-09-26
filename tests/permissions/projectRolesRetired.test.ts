import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';

// The project roles RETIRE as grants (Story MOTIR-6168 · MOTIR-6464;
// `docs/decisions/role-model.md` §3). Roles live on the workspace — one per
// person, the same in every project — so the server stops accepting, storing or
// reporting a PROJECT role:
//
//   * adding a person to a project takes no role, and a request carrying one is
//     refused (400 `role_retired`) rather than silently ignored — a role that
//     looks accepted and means nothing is the failure this story exists to end;
//   * setting a project member's role, and authoring a project custom role,
//     answer 410 Gone naming the workspace replacement — kept as stubs so a stale
//     client reads a reason, not a 404;
//   * removing the last former project `admin` succeeds: there is no project
//     admin to protect.
//
// It replaces the transport tests of the retired routes
// (`roleDefinitionRoutes.test.ts`) and of project-role assignment
// (`roleAssignment.test.ts`); where a case still has a meaning it moved to the
// workspace role (`tests/workspaces/memberRoleRoute.test.ts`).
//
// `getWorkspaceContext` is the one seam stubbed (no cookies in the test env).

const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { POST: membersPOST } = await import('@/app/api/projects/[key]/members/route');
const { PATCH: memberPATCH, DELETE: memberDELETE } =
  await import('@/app/api/projects/[key]/members/[userId]/route');
const { POST: rolesPOST } = await import('@/app/api/projects/[key]/roles/route');
const { PATCH: rolePATCH, DELETE: roleDELETE } =
  await import('@/app/api/projects/[key]/roles/[roleId]/route');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { truncateAuthTables } = await import('../helpers/db');

beforeEach(async () => {
  ctxRef.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function build(slug: string) {
  const owner = await usersService.createUser({
    email: `owner-${slug}@ex.com`,
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
  const member = await usersService.createUser({
    email: `member-${slug}@ex.com`,
    password: 'hunter2hunter2',
    name: 'Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  return {
    workspaceId: workspace.id,
    projectId: project.id,
    key: project.identifier,
    ownerCtx: { userId: owner.id, workspaceId: workspace.id },
    memberId: member.id,
  };
}

function post(key: string, body: unknown) {
  return membersPOST(
    new Request('http://t/api/projects/x/members', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) } as never,
  );
}

describe('POST /api/projects/[key]/members — people only', () => {
  it('adds the person with `{ userId }` (201), and the response carries no role', async () => {
    const fx = await build('add');
    ctxRef.current = fx.ownerCtx;
    const res = await post(fx.key, { userId: fx.memberId });
    expect(res.status).toBe(201);
    const { member } = (await res.json()) as { member: Record<string, unknown> };
    expect(Object.keys(member).sort()).toEqual(['email', 'name', 'userId']);
    expect(await adminDb.projectMembership.count({ where: { projectId: fx.projectId } })).toBe(1);
  });

  it('refuses a body carrying a role with 400 role_retired naming the workspace Members page, and adds nobody', async () => {
    const fx = await build('role');
    ctxRef.current = fx.ownerCtx;
    for (const role of ['member', 'admin', 'viewer', 'anything']) {
      const res = await post(fx.key, { userId: fx.memberId, role });
      expect(res.status, role).toBe(400);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('role_retired');
      expect(body.error).toContain('/settings/workspace');
    }
    expect(await adminDb.projectMembership.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('a missing userId, or a body that is not JSON, is 400', async () => {
    const fx = await build('bad');
    ctxRef.current = fx.ownerCtx;
    expect((await post(fx.key, {})).status).toBe(400);
    const notJson = await membersPOST(
      new Request('http://t/api/projects/x/members', { method: 'POST', body: 'nope' }),
      { params: Promise.resolve({ key: fx.key }) } as never,
    );
    expect(notJson.status).toBe(400);
  });
});

describe('the retired role handlers answer 410 Gone, naming the workspace replacement', () => {
  it('PATCH /api/projects/[key]/members/[userId]', async () => {
    const res = await memberPATCH();
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('role_retired');
    expect(body.error).toContain('/api/workspaces/{workspaceId}/members/{userId}');
  });

  it('POST /api/projects/[key]/roles, and PATCH / DELETE /api/projects/[key]/roles/[roleId]', async () => {
    for (const res of [await rolesPOST(), await rolePATCH(), await roleDELETE()]) {
      expect(res.status).toBe(410);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('project_roles_retired');
      expect(body.error).toContain('/api/workspaces/{workspaceId}/roles');
    }
  });
});

describe('DELETE /api/projects/[key]/members/[userId] — no last-admin guard', () => {
  it('removes the last person who was a project admin', async () => {
    const fx = await build('last-admin');
    await adminDb.projectMembership.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        userId: fx.memberId,
        role: 'admin',
      },
    });
    ctxRef.current = fx.ownerCtx;
    const res = await memberDELETE(new Request('http://t', { method: 'DELETE' }), {
      params: Promise.resolve({ key: fx.key, userId: fx.memberId }),
    } as never);
    expect(res.status).toBe(200);
    expect(await adminDb.projectMembership.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});

describe('no path writes a project role any more', () => {
  const ROOT = join(__dirname, '..', '..');
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

  it('the membership repository has no role writer — only create, bulk create and delete touch the row', () => {
    const src = read('lib/repositories/projectMembershipRepository.ts');
    for (const gone of [
      'setRoleDefinition',
      'reassignRoleDefinition',
      'countAdmins',
      'countByRole',
    ]) {
      expect(src, gone).not.toMatch(new RegExp(`\\basync ${gone}\\(`));
    }
    expect(src).not.toMatch(/projectMembership\.update(Many)?\(/);
  });

  it('nothing under lib/ updates a project membership row — a role cannot be written by another door', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith('.ts')
            ? [join(dir, e.name)]
            : [],
      );
    const offenders = walk(join(ROOT, 'lib')).filter((f) =>
      /\.projectMembership\.(update|updateMany|upsert)\(/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
