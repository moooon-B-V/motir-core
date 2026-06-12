import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { ProjectContext } from '@/lib/projects';
import { truncateAuthTables } from '../helpers/db';

// Action-wiring tests for the editable Details page (Subtask 6.8.4). These prove
// the TRANSPORT layer — `app/(authed)/settings/project/actions.ts` — resolves
// the session + active project, calls the right 6.8.1 service method, and maps
// each typed service error to the discriminated RESULT code the modals render
// distinct copy from. The deep tx/collision/race behaviour is 6.8.1's
// service-test surface; here we assert the action↔service contract only.
//
// `getSession` + `getActiveProject` are the only mocks (the no-cookie test env);
// every DB call goes through the real services against real Postgres.

const sessionUser = { id: '', email: '', name: 'Actor' };
let activeCtx: ProjectContext | null = null;

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(async () => (sessionUser.id ? { user: sessionUser } : null)),
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () => activeCtx),
}));

const { updateProjectDetailsAction, changeProjectKeyAction, releaseProjectKeyAction } =
  await import('@/app/(authed)/settings/project/actions');

const PASSWORD = 'hunter2hunter2';

function setActor(userId: string, email: string) {
  sessionUser.id = userId;
  sessionUser.email = email;
}
function setActive(userId: string, workspaceId: string, project: ProjectDTO) {
  activeCtx = { userId, workspaceId, projectId: project.id, project };
}

beforeEach(async () => {
  await truncateAuthTables();
});
afterEach(() => {
  activeCtx = null;
  sessionUser.id = '';
  sessionUser.email = '';
  vi.clearAllMocks();
});
afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

// An owner + workspace + project; the owner is the workspace OWNER (manages the
// project via the workspace tier). Returns the bits the action mocks need.
async function makeFixture(slug: string, identifier = 'PROD') {
  const owner = await makeUser(`owner-${slug}@example.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
    identifier,
  });
  setActor(owner.id, `owner-${slug}@example.com`);
  setActive(owner.id, workspace.id, project);
  return { owner, workspace, project };
}

describe('project-details actions (6.8.4 wiring)', () => {
  it('updateProjectDetailsAction saves name + avatar and returns the DTO', async () => {
    await makeFixture('a');
    const result = await updateProjectDetailsAction({
      name: 'Renamed',
      avatarIcon: 'rocket',
      avatarColor: 'lavender',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.name).toBe('Renamed');
      expect(result.project.avatarIcon).toBe('rocket');
      expect(result.project.avatarColor).toBe('lavender');
    }
  });

  it('updateProjectDetailsAction maps a blank name → INVALID_NAME and a bad icon → INVALID_AVATAR', async () => {
    await makeFixture('b');
    expect(await updateProjectDetailsAction({ name: '   ' })).toEqual({
      ok: false,
      code: 'INVALID_NAME',
    });
    expect(await updateProjectDetailsAction({ avatarIcon: 'not-a-real-icon' })).toEqual({
      ok: false,
      code: 'INVALID_AVATAR',
    });
  });

  it('changeProjectKeyAction re-keys, reserves the old key, and returns it under previousKeys', async () => {
    await makeFixture('c');
    const result = await changeProjectKeyAction('nif'); // lower-case → the service upper-cases
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.identifier).toBe('NIF');
      expect(result.project.previousKeys?.map((p) => p.identifier)).toContain('PROD');
    }
  });

  it('changeProjectKeyAction maps the collision matrix to its distinct codes', async () => {
    const { owner, workspace } = await makeFixture('d');
    // A second LIVE project in the same workspace → IDENTIFIER_TAKEN.
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Labs',
      identifier: 'LABS',
    });
    expect(await changeProjectKeyAction('LABS')).toEqual({ ok: false, code: 'IDENTIFIER_TAKEN' });
    // Malformed key → INVALID_IDENTIFIER; unchanged → IDENTIFIER_UNCHANGED.
    expect(await changeProjectKeyAction('N!')).toEqual({ ok: false, code: 'INVALID_IDENTIFIER' });
    expect(await changeProjectKeyAction('PROD')).toEqual({
      ok: false,
      code: 'IDENTIFIER_UNCHANGED',
    });
  });

  it('changeProjectKeyAction maps another project’s retired key → IDENTIFIER_RESERVED', async () => {
    const { owner, workspace, project } = await makeFixture('e');
    // A second project retires APX (APX→APXX), reserving APX as its alias.
    const other = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Apex',
      identifier: 'APX',
    });
    setActive(owner.id, workspace.id, other);
    await changeProjectKeyAction('APXX');
    // Back on the PROD project, APX is now reserved by Apex.
    setActive(owner.id, workspace.id, project);
    expect(await changeProjectKeyAction('APX')).toEqual({ ok: false, code: 'IDENTIFIER_RESERVED' });
  });

  it('releaseProjectKeyAction releases an own alias and 404s an unknown one', async () => {
    const { project } = await makeFixture('f');
    const changed = await changeProjectKeyAction('NIF');
    expect(changed.ok).toBe(true);
    // Re-point the active ctx at the (now NIF-keyed) project for the release.
    if (changed.ok) setActive(activeCtx!.userId, activeCtx!.workspaceId, changed.project);
    const released = await releaseProjectKeyAction('PROD');
    expect(released.ok).toBe(true);
    if (released.ok) expect(released.project.previousKeys ?? []).toHaveLength(0);
    expect(await releaseProjectKeyAction('ZZZZ')).toEqual({ ok: false, code: 'ALIAS_NOT_FOUND' });
    void project;
  });

  it('every action rejects a non-admin member with NOT_ADMIN', async () => {
    const { workspace, project } = await makeFixture('g');
    const member = await makeUser('member-g@example.com', 'Member');
    await workspacesService.addMember({
      userId: member.id,
      workspaceId: workspace.id,
      role: 'member',
    });
    setActor(member.id, 'member-g@example.com');
    setActive(member.id, workspace.id, project);
    expect(await updateProjectDetailsAction({ name: 'Nope' })).toEqual({
      ok: false,
      code: 'NOT_ADMIN',
    });
    expect(await changeProjectKeyAction('NIF')).toEqual({ ok: false, code: 'NOT_ADMIN' });
    expect(await releaseProjectKeyAction('PROD')).toEqual({ ok: false, code: 'NOT_ADMIN' });
  });
});
