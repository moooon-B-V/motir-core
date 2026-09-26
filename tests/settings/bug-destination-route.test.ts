import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { NotProjectAdminError } from '@/lib/projects/errors';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { seededBugsFolderId } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// `PATCH /api/projects/[key]/bug-destination` and the room's read — the Bugs
// room's two doors (Story MOTIR-4927 · Subtask MOTIR-4938), over the REAL stack.
//
// The session is the one thing stubbed (a route test has no cookie jar).
// Everything after it — `getByKey`, `bugDestinationService`, the permission
// resolution, Postgres and its same-project trigger — is the shipped path.
//
// Pinned: an admin re-points the destination to a nested folder and to the
// project root, each persisting, with the room's whole view as the body; a folder
// of ANOTHER project is a no-leak 404 and nothing moves; a MEMBER without
// `project:administer` is refused on the write (403) and the read; and a body that
// names neither a folder id nor null is a 400.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const { PATCH } = await import('@/app/api/projects/[key]/bug-destination/route');

const PASSWORD = 'bug-destination-route-pass-123';

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
  await addToProjectAs({
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
    bugs: await seededBugsFolderId(project.id),
  };
}

async function stored(projectId: string) {
  const row = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  return row.bugDestinationFolderId;
}

function actAs(ctx: WorkspaceContext) {
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx });
}

const params = (key: string) => ({ params: Promise.resolve({ key }) });
const patch = (body: unknown) =>
  new Request('https://app.motir.co/api/projects/X/bug-destination', {
    method: 'PATCH',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('the Bugs room read', () => {
  it('names the seeded Bugs folder as both the destination and this project’s Bugs folder', async () => {
    const s = await seed('read');
    const bugs = { id: s.bugs, name: 'Bugs', path: ['Bugs'] };

    await expect(bugDestinationService.getSettings(s.project.id, s.owner)).resolves.toEqual({
      folder: bugs,
      bugsFolder: bugs,
    });
  });

  it('refuses a MEMBER without `project:administer`', async () => {
    const s = await seed('read-member');

    await expect(bugDestinationService.getSettings(s.project.id, s.member)).rejects.toBeInstanceOf(
      NotProjectAdminError,
    );
  });
});

describe('PATCH /api/projects/[key]/bug-destination', () => {
  it('an ADMIN re-points it to a nested folder, then to the project root; each persists and the body is the room’s view', async () => {
    const s = await seed('admin');
    const triage = await foldersService.createFolder(
      { projectId: s.project.id, parentFolderId: s.bugs, name: 'Triage' },
      s.owner,
    );
    const bugs = { id: s.bugs, name: 'Bugs', path: ['Bugs'] };
    actAs(s.owner);

    const toFolder = await PATCH(patch({ folderId: triage.id }), params(s.project.identifier));
    expect(toFolder.status).toBe(200);
    expect(await toFolder.json()).toEqual({
      folder: { id: triage.id, name: 'Triage', path: ['Bugs', 'Triage'] },
      bugsFolder: bugs,
    });
    expect(await stored(s.project.id)).toBe(triage.id);

    const toRoot = await PATCH(patch({ folderId: null }), params(s.project.identifier));
    expect(toRoot.status).toBe(200);
    expect(await toRoot.json()).toEqual({ folder: null, bugsFolder: bugs });
    expect(await stored(s.project.id)).toBeNull();
  });

  it('a folder of ANOTHER project is refused as not found, and the pointer does not move', async () => {
    const s = await seed('cross');
    const other = await projectsService.createProject({
      workspaceId: s.workspaceId,
      actorUserId: s.owner.userId,
      name: 'Other project',
    });
    const foreign = await seededBugsFolderId(other.id);
    actAs(s.owner);

    const res = await PATCH(patch({ folderId: foreign }), params(s.project.identifier));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    expect(await stored(s.project.id)).toBe(s.bugs);
  });

  it('a MEMBER without `project:administer` is refused with a 403, and nothing moves', async () => {
    const s = await seed('member');
    actAs(s.member);

    const res = await PATCH(patch({ folderId: null }), params(s.project.identifier));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'NOT_PROJECT_ADMIN' });
    expect(await stored(s.project.id)).toBe(s.bugs);
  });

  it('a body naming neither a folder id nor null is a 400, and nothing moves', async () => {
    const s = await seed('invalid');
    actAs(s.owner);

    for (const body of [{ folderId: 7 }, { folderId: '' }, {}]) {
      const res = await PATCH(patch(body), params(s.project.identifier));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_BUG_DESTINATION' });
    }
    const malformed = await PATCH(patch('{not json'), params(s.project.identifier));
    expect(malformed.status).toBe(400);
    expect(await stored(s.project.id)).toBe(s.bugs);
  });
});
