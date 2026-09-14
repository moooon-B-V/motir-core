import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `PATCH /api/projects/[key]/pr-merge-mode` — the merge-mode card's write door
// (Story MOTIR-4880 · Subtask MOTIR-5181), over the REAL stack.
//
// The session is the one thing stubbed (a route test has no cookie jar).
// Everything after it — `getByKey`, `projectPrMergeModeService`, the permission
// resolution, Postgres — is the shipped path.
//
// Pinned: a manager's write persists and is stamped decided; a MEMBER is refused
// with a 403 naming `workflow:manage` and the stored value does not move (the
// room is manage-only); a value outside `auto | manual` — including the retired
// `review_on_fail` — is a 400; and two projects in ONE workspace hold different
// values through the door.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const { PATCH } = await import('@/app/api/projects/[key]/pr-merge-mode/route');

const PASSWORD = 'pr-merge-mode-route-pass-123';

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctxFor = (userId: string, workspaceId: string): WorkspaceContext => ({ userId, workspaceId });

async function seed(slug: string) {
  const user = (email: string, name: string) =>
    usersService.createUser({ email, password: PASSWORD, name });

  const owner = await user(`owner-${slug}@ex.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const ownerCtx = ctxFor(owner.id, workspace.id);
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });

  const memberUser = await user(`member-${slug}@ex.com`, 'Member');
  await workspacesService.addMember({ userId: memberUser.id, workspaceId: workspace.id });
  await projectMembersService.addMember({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    targetUserId: memberUser.id,
    role: 'member',
  });

  return {
    workspaceId: workspace.id,
    owner: ownerCtx,
    member: ctxFor(memberUser.id, workspace.id),
    project,
  };
}

async function stored(projectId: string) {
  const row = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  return { mode: row.prMergeMode, decidedAt: row.prMergeModeDecidedAt };
}

function actAs(ctx: WorkspaceContext) {
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx });
}

const params = (key: string) => ({ params: Promise.resolve({ key }) });
const patch = (body: unknown) =>
  new Request('https://app.motir.co/api/projects/X/pr-merge-mode', {
    method: 'PATCH',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('PATCH /api/projects/[key]/pr-merge-mode', () => {
  it('a MANAGER changes the value; it persists, is stamped decided, and the body is the new value', async () => {
    const s = await seed('manager');
    expect((await stored(s.project.id)).mode).toBe('manual');

    actAs(s.owner);
    const res = await PATCH(patch({ prMergeMode: 'auto' }), params(s.project.identifier));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prMergeMode: 'auto' });
    const after = await stored(s.project.id);
    expect(after.mode).toBe('auto');
    expect(after.decidedAt).not.toBeNull();
  });

  it('a MEMBER without `workflow:manage` is refused with a 403 naming the key, and nothing moves', async () => {
    const s = await seed('member');

    actAs(s.member);
    const res = await PATCH(patch({ prMergeMode: 'auto' }), params(s.project.identifier));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ permission: 'workflow:manage' });
    expect(await stored(s.project.id)).toEqual({ mode: 'manual', decidedAt: null });
  });

  it.each(['review_on_fail', 'AUTO', undefined, true])(
    'refuses %s as a 400 before writing anything',
    async (value) => {
      const s = await seed(`invalid-${String(value)}`);

      actAs(s.owner);
      const res = await PATCH(patch({ prMergeMode: value }), params(s.project.identifier));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_PR_MERGE_MODE' });
      expect(await stored(s.project.id)).toEqual({ mode: 'manual', decidedAt: null });
    },
  );

  it('a body that is not JSON is a 400', async () => {
    const s = await seed('not-json');
    actAs(s.owner);
    const res = await PATCH(patch('not json'), params(s.project.identifier));
    expect(res.status).toBe(400);
  });

  it('a JSON `null` body carries no mode, so it is refused as an invalid value', async () => {
    const s = await seed('null-body');
    actAs(s.owner);
    const res = await PATCH(patch('null'), params(s.project.identifier));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_PR_MERGE_MODE' });
  });

  it('an unauthenticated request is answered by the compliance gate, before any lookup', async () => {
    const refusal = Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: false, response: refusal });
    const res = await PATCH(patch({ prMergeMode: 'auto' }), params('ANY'));
    expect(res).toBe(refusal);
  });

  it('an error the route does not map is rethrown, not swallowed into a status', async () => {
    const s = await seed('rethrow');
    actAs(s.owner);
    const boom = new Error('boom');
    const spy = vi.spyOn(projectsService, 'getByKey').mockRejectedValueOnce(boom);
    await expect(PATCH(patch({ prMergeMode: 'auto' }), params(s.project.identifier))).rejects.toBe(
      boom,
    );
    spy.mockRestore();
  });

  it('an unknown project key is a 404', async () => {
    const s = await seed('unknown');
    actAs(s.owner);
    const res = await PATCH(patch({ prMergeMode: 'auto' }), params('NOPE'));
    expect(res.status).toBe(404);
  });

  it('two projects in ONE workspace hold different values through the door', async () => {
    const s = await seed('two');
    const second = await projectsService.createProject({
      workspaceId: s.workspaceId,
      actorUserId: s.owner.userId,
      name: 'Second project',
    });

    actAs(s.owner);
    expect((await PATCH(patch({ prMergeMode: 'auto' }), params(s.project.identifier))).status).toBe(
      200,
    );
    expect((await PATCH(patch({ prMergeMode: 'manual' }), params(second.identifier))).status).toBe(
      200,
    );

    expect((await stored(s.project.id)).mode).toBe('auto');
    expect((await stored(second.id)).mode).toBe('manual');
  });
});
