import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces/context';

// Assigning a CUSTOM role (Story MOTIR-2257 · Subtask MOTIR-2485) — the two
// things the SERVICE tests in `tests/project-members-service.test.ts` cannot say
// on their own:
//
//   * the HTTP half. The service throws `RoleDefinitionNotFoundError`; whether a
//     caller sees a 404 is a fact about `projectMemberErrorResponse`, and only
//     reading the RESPONSE proves it. The 404-not-403 posture is the whole point:
//     `PATCH …/members/[userId]` must not become a probe for whether a role in
//     another workspace exists.
//   * the STRUCTURAL guard. The paired-column invariant (`role` is a tier,
//     `role_definition_id` is the pointer, and they are written together) is not
//     something a runtime test can defend against code that has not been written
//     yet. So this file reads `lib/services/` and asserts that no service reaches
//     `role_definition_id` except through the two sanctioned repository methods.
//
// `getWorkspaceContext` is the one seam stubbed (no cookies in the test env) —
// the same single exception the repo's convention allows. Everything below is the
// real path against a real database.

const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { PATCH: memberPATCH } = await import('@/app/api/projects/[key]/members/[userId]/route');
const { projectsService } = await import('@/lib/services/projectsService');
const { projectMembersService } = await import('@/lib/services/projectMembersService');
const { projectRoleDefinitionService } =
  await import('@/lib/services/projectRoleDefinitionService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { truncateAuthTables } = await import('../helpers/db');

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  ctxRef.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  adminCtx: WorkspaceContext;
  memberCtx: WorkspaceContext;
  memberUserId: string;
}

/**
 * ⚠️ `projectName` IS A REAL PARAMETER, not decoration. A project's identifier is
 * DERIVED from its name, so two fixtures both called `Project <slug>` land on the
 * same key — and a "cross-workspace" test written against them would silently
 * resolve to the actor's OWN project and prove nothing.
 */
async function build(slug: string, projectName?: string): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: `owner-${slug}@ex.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: projectName ?? `Project ${slug}`,
  });
  const adminCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };

  const member = await usersService.createUser({
    email: `member-${slug}@ex.com`,
    password: PASSWORD,
    name: 'Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  await projectMembersService.addMember({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: adminCtx,
    targetUserId: member.id,
    role: 'viewer',
  });

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    adminCtx,
    memberCtx: { userId: member.id, workspaceId: workspace.id },
    memberUserId: member.id,
  };
}

function patchMember(key: string, userId: string, body: unknown): Promise<Response> {
  return memberPATCH(
    new Request('http://t/api/projects/x/members/y', {
      method: 'PATCH',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ key, userId }) },
  );
}

describe('PATCH /api/projects/[key]/members/[userId] — role assignment (MOTIR-2485)', () => {
  it('assigns one of the project’s own roles and returns the member wearing it', async () => {
    const fx = await build('assign');
    const role = await projectRoleDefinitionService.create({
      projectId: fx.projectId,
      ctx: fx.adminCtx,
      name: 'Contractor',
      permissions: ['project:browse'],
    });
    ctxRef.current = fx.adminCtx;

    const res = await patchMember(fx.projectKey, fx.memberUserId, { role: role.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      member: { role: string; roleDefinition: { id: string; name: string } | null };
    };
    expect(body.member.roleDefinition).toEqual({ id: role.id, name: 'Contractor' });
    // The tier travelled with it — the member row and the resolution agree.
    expect(body.member.role).toBe('member');
  });

  it('a built-in still assigns, and clears the pointer on the way', async () => {
    const fx = await build('builtin');
    const role = await projectRoleDefinitionService.create({
      projectId: fx.projectId,
      ctx: fx.adminCtx,
      name: 'Contractor',
      permissions: ['project:browse'],
    });
    ctxRef.current = fx.adminCtx;
    await patchMember(fx.projectKey, fx.memberUserId, { role: role.id });

    const res = await patchMember(fx.projectKey, fx.memberUserId, { role: 'admin' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      member: { role: string; roleDefinition: unknown };
    };
    expect(body.member.role).toBe('admin');
    expect(body.member.roleDefinition).toBeNull();
  });

  it('ANOTHER WORKSPACE’s role definition is a 404 — indistinguishable from one that never existed', async () => {
    const mine = await build('mine', 'Alpha');
    const theirs = await build('theirs', 'Beta');
    expect(mine.projectKey).not.toBe(theirs.projectKey); // the fixtures must genuinely differ
    const foreign = await projectRoleDefinitionService.create({
      projectId: theirs.projectId,
      ctx: theirs.adminCtx,
      name: 'Contractor',
      permissions: ['project:browse'],
    });

    // Driven under MY workspace context, naming THEIR role.
    ctxRef.current = mine.adminCtx;
    const foreignRes = await patchMember(mine.projectKey, mine.memberUserId, { role: foreign.id });
    const inventedRes = await patchMember(mine.projectKey, mine.memberUserId, {
      role: 'role-that-never-existed',
    });

    expect(foreignRes.status).toBe(404);
    expect(inventedRes.status).toBe(404);
    // Same status AND same code — a caller cannot tell the two apart, which is
    // what stops the endpoint being used to probe a foreign workspace.
    const [a, b] = await Promise.all([foreignRes.json(), inventedRes.json()]);
    expect((a as { code: string }).code).toBe((b as { code: string }).code);
    expect((a as { code: string }).code).toBe('ROLE_DEFINITION_NOT_FOUND');

    // ⚠️ AND NOTHING WAS WRITTEN. The refusal lands before the assignment, so a
    // rejected PATCH cannot leave a membership half-moved.
    const members = await projectMembersService.listMembers({
      key: mine.projectKey,
      actorUserId: mine.adminCtx.userId,
      ctx: mine.adminCtx,
    });
    const row = members.find((m) => m.userId === mine.memberUserId);
    expect(row?.role).toBe('viewer');
    expect(row?.roleDefinition).toBeNull();
  });

  it('an actor who cannot manage members gets 403 — the shipped gate, re-asserted not re-implemented', async () => {
    const fx = await build('gate');
    const role = await projectRoleDefinitionService.create({
      projectId: fx.projectId,
      ctx: fx.adminCtx,
      name: 'Contractor',
      permissions: ['project:browse'],
    });
    // The project's `viewer` — can browse, cannot manage members.
    ctxRef.current = fx.memberCtx;

    const res = await patchMember(fx.projectKey, fx.memberUserId, { role: role.id });
    expect(res.status).toBe(403);
  });

  it('the gate runs BEFORE the role is resolved — a non-manager cannot probe role ids either', async () => {
    const fx = await build('gate-order');
    ctxRef.current = fx.memberCtx;
    // An id that certainly does not exist. If the resolution ran first this would
    // be a 404, which would tell a non-manager that the id is unknown.
    const res = await patchMember(fx.projectKey, fx.memberUserId, { role: 'nope' });
    expect(res.status).toBe(403);
  });
});

// ── The structural guard ────────────────────────────────────────────────────
//
// ⚠️ ONE COLUMN, TWO SANCTIONED WRITERS, AND NO THIRD. `role_definition_id` is
// half of a pair — the other half is `role`, the tier — and the two are only
// ever correct when written in the SAME statement. `setRoleDefinition` (one
// member) and `reassignRoleDefinition` (the bulk move a deletion performs) both
// do that. A service that reached the column any other way could write a pointer
// without its tier, which produces a member whose screens say one thing and whose
// permissions do another — the exact class of bug that is invisible until someone
// cannot do their job.
//
// A runtime test cannot defend against code nobody has written yet, so this one
// reads the source.
describe('no second write path to role_definition_id', () => {
  const SERVICES_DIR = join(process.cwd(), 'lib/services');

  function serviceSources(): { file: string; source: string }[] {
    return readdirSync(SERVICES_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({ file: f, source: readFileSync(join(SERVICES_DIR, f), 'utf8') }));
  }

  it('the REPOSITORY exposes exactly two methods that write the column', () => {
    // The other end of the same guard: bounding the callers only helps while the
    // write surface itself stays bounded. A `data: { roleDefinitionId … }` is the
    // only way a Prisma write reaches the column, so counting them counts the
    // writers — and each of the two writes `role` in the SAME object, which is
    // the invariant itself, spelled out.
    const source = readFileSync(
      join(process.cwd(), 'lib/repositories/projectMembershipRepository.ts'),
      'utf8',
    );
    const writes = [...source.matchAll(/data:\s*\{[^}]*roleDefinitionId[^}]*\}/g)].map((m) => m[0]);
    expect(writes).toHaveLength(2);
    for (const write of writes) expect(write).toContain('role:');
  });

  it('only the two sanctioned repository methods are called to write it', () => {
    const callers = new Map<string, string[]>();
    for (const { file, source } of serviceSources()) {
      const found = [
        ...(source.includes('setRoleDefinition') ? ['setRoleDefinition'] : []),
        ...(source.includes('reassignRoleDefinition') ? ['reassignRoleDefinition'] : []),
      ];
      if (found.length) callers.set(file, found);
    }

    // ⚠️ ONE CALLER EACH, AND THEY ARE THE TWO THE CARD NAMES. The single-member
    // assignment belongs to the members service; the bulk move belongs to the
    // role service; neither reimplements the other.
    expect(callers.get('projectMembersService.ts')).toEqual(['setRoleDefinition']);
    expect(callers.get('projectRoleDefinitionService.ts')).toEqual(['reassignRoleDefinition']);
    expect([...callers.keys()].sort()).toEqual([
      'projectMembersService.ts',
      'projectRoleDefinitionService.ts',
    ]);
  });

  it('`updateRole` is GONE from the membership repository — it wrote the tier alone', () => {
    // It was safe until the pointer existed and became a live bug the moment it
    // did: a "demotion" through it would leave the pointer intact, so the member
    // would keep resolving through a custom role every screen said they had lost.
    const source = readFileSync(
      join(process.cwd(), 'lib/repositories/projectMembershipRepository.ts'),
      'utf8',
    );
    expect(/async updateRole\(/.test(source)).toBe(false);
  });
});
