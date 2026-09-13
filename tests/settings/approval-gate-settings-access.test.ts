import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { approvalGateSettingsService } from '@/lib/services/approvalGateSettingsService';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Task MOTIR-5278 — the Approvals room's two keys, over the REAL stack.
//
// `design/projects/design-notes.md` § ⭐ Approvals §6 (decided on MOTIR-5190): the
// room is SEEN by every project browser and CHANGED by an admin. The registry
// entry declares that pair (`viewPermission: 'project:browse'`,
// `permission: 'workflow:manage'`), and the rail now admits a member. That makes
// the service's READ the thing that decides whether the door the rail just
// offered opens onto a room or onto a crash — so it is proven here against a real
// seeded membership rather than a typed permission set.
//
// Three facts, each with its control:
//   1. a MEMBER's read returns the STORED value (not a default — it is flipped off
//      first, so a hard-coded `true` cannot pass);
//   2. the same member's WRITE is refused, at the service AND as a 403 on the route
//      — while an ADMIN's identical write goes through, so the refusal is about
//      the key and not a broken fixture;
//   3. a NON-browser's read is still `ProjectNotFoundError` at the service — the
//      key moved, the 404-vs-403 posture did not. (The ROUTE's 404 for that actor
//      is MOTIR-5320's; see the note at the bottom of this file.)
//
// The session is the one thing stubbed: a route test has no cookie jar, so the
// compliance gate hands back the actor. Everything after it — `getByKey`, the
// service, the permission resolution, Postgres — is the shipped path.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const { GET, PATCH } = await import('@/app/api/projects/[key]/approval-gates/route');

const PASSWORD = 'approval-gate-access-pass-123';

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctxFor = (userId: string, workspaceId: string): WorkspaceContext => ({ userId, workspaceId });

interface Seeded {
  projectId: string;
  projectKey: string;
  admin: WorkspaceContext;
  member: WorkspaceContext;
  /** A workspace member with no role on a PRIVATE project — cannot browse it. */
  outsider: WorkspaceContext;
}

/**
 * A PRIVATE project, so the non-browser arm is a real one: the access level is
 * set before anyone else joins (going private seeds only the then-current
 * members), then a project admin, a project member and a workspace member with no
 * project role are added — the same order `settings-area-access-matrix` uses.
 */
async function seed(slug: string): Promise<Seeded> {
  const user = (email: string, name: string) =>
    usersService.createUser({ email, password: PASSWORD, name });

  const owner = await user(`owner-${slug}@ex.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ownerCtx = ctxFor(owner.id, workspace.id);
  await projectMembersService.setAccessLevel({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    level: 'private',
  });

  async function projectActor(role: 'admin' | 'member') {
    const u = await user(`${role}-${slug}@ex.com`, role);
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: u.id,
      role,
    });
    return ctxFor(u.id, workspace.id);
  }

  const outsider = await user(`outsider-${slug}@ex.com`, 'Outsider');
  await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });

  return {
    projectId: project.id,
    projectKey: project.identifier,
    admin: await projectActor('admin'),
    member: await projectActor('member'),
    outsider: ctxFor(outsider.id, workspace.id),
  };
}

/** Put the stored switch in a known, NON-default state. */
async function storeAcceptanceVideo(projectId: string, value: boolean) {
  await adminDb.project.update({
    where: { id: projectId },
    data: { acceptanceVideoEnabled: value },
  });
}

async function storedAcceptanceVideo(projectId: string): Promise<boolean> {
  const row = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  return row.acceptanceVideoEnabled;
}

function actAs(ctx: WorkspaceContext) {
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx });
}

const params = (key: string) => ({ params: Promise.resolve({ key }) });
const patchBody = (body: unknown) =>
  new Request('https://app.motir.co/api/projects/X/approval-gates', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

describe('the READ is open to every project browser (MOTIR-5278)', () => {
  it('a project MEMBER reads the STORED value — at the service and through GET', async () => {
    const s = await seed('member-read');
    // Off, because the column defaults on: a read that ignored the row would pass
    // a default-valued fixture.
    await storeAcceptanceVideo(s.projectId, false);

    await expect(approvalGateSettingsService.getSettings(s.projectId, s.member)).resolves.toEqual({
      acceptanceVideoEnabled: false,
    });

    actAs(s.member);
    const res = await GET(new Request('https://app.motir.co/x'), params(s.projectKey));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acceptanceVideoEnabled: false });
  });
});

describe('the WRITE keeps `workflow:manage` (MOTIR-5278)', () => {
  it('the same MEMBER’s write is REFUSED at the service, and the stored value does not move', async () => {
    const s = await seed('member-write-service');
    await storeAcceptanceVideo(s.projectId, false);

    const attempt = approvalGateSettingsService.updateSettings(
      s.projectId,
      { acceptanceVideoEnabled: true },
      s.member,
    );
    await expect(attempt).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(attempt).rejects.toMatchObject({ permission: 'workflow:manage' });
    expect(await storedAcceptanceVideo(s.projectId)).toBe(false);
  });

  it('…and is a 403 on `PATCH /api/projects/[key]/approval-gates`, naming the key', async () => {
    const s = await seed('member-write-route');
    await storeAcceptanceVideo(s.projectId, false);

    actAs(s.member);
    const res = await PATCH(patchBody({ acceptanceVideoEnabled: true }), params(s.projectKey));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ permission: 'workflow:manage' });
    expect(await storedAcceptanceVideo(s.projectId)).toBe(false);
  });

  it('CONTROL: an ADMIN’s identical PATCH goes through — the refusal is the key, not the fixture', async () => {
    const s = await seed('admin-write-route');
    await storeAcceptanceVideo(s.projectId, false);

    actAs(s.admin);
    const res = await PATCH(patchBody({ acceptanceVideoEnabled: true }), params(s.projectKey));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acceptanceVideoEnabled: true });
    expect(await storedAcceptanceVideo(s.projectId)).toBe(true);
  });
});

describe('a NON-browser still cannot learn the room exists — the 404-vs-403 posture (MOTIR-5278)', () => {
  it('reads as ProjectNotFoundError at the service, not PermissionDeniedError', async () => {
    const s = await seed('outsider-service');
    await expect(
      approvalGateSettingsService.getSettings(s.projectId, s.outsider),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  // ⚠️ NO ROUTE-LEVEL 404 CASE HERE, AND THAT IS A FILED DEFECT, NOT AN OVERSIGHT.
  // One was written, and it went red on the shipped route before this card's
  // change is ever reached: `projectsService.getByKey` refuses an in-workspace
  // non-browser with `ProjectAccessDeniedError` — its own doc promises
  // `ProjectNotFoundError` — and this route, like twelve other
  // `/api/projects/[key]/*` routes, maps only the promised one, so the refusal
  // escapes as a 500. That is MOTIR-5320, whose first criterion is exactly the
  // case removed here, on this file's fixture. Asserting the 500 would pin the
  // defect; asserting the 404 would fail on code this card does not own.
});
