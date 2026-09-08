import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// MOTIR-4870 — YOU ARE ALWAYS IN A PROJECT, and the seam is the WORKSPACE.
//
// The card this belongs to was authored saying the zero-project window is
// "exactly one moment" (registration). It is not: `createWorkspace` inserts a
// workspace and its owner memberships and no project, and archiving the last
// project puts a long-lived workspace back into the same state. So the
// invariant is enforced where `ensureDefaultWorkspace` enforces its own — at
// the tier that OWNS the entity, best-effort at creation and lazily in the
// resolver — and this file asserts it at all three doors rather than at the
// one where the defect was noticed.
//
// Real Postgres; truncate between tests (CLAUDE.md: never mock the DB).

const BASE_URL = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Every project row in the tenant, read past RLS — the count the invariant is about. */
async function allProjects() {
  return adminDb.project.findMany({ orderBy: { createdAt: 'asc' } });
}

async function firstWorkspaceOf(userId: string) {
  const membership = await adminDb.workspaceMembership.findFirst({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: 'asc' },
  });
  return membership!.workspace;
}

describe('door 1 — REGISTRATION', () => {
  // ⚠️ THE SEED IS THE RESOLVER'S, NOT A SIGN-UP HOOK'S — and the criterion is
  // phrased for exactly that: "a newly registered account has exactly one
  // project WHEN ITS FIRST AUTHED REQUEST IS SERVED". Seeding it in
  // `user.create.after` would import `projectsService` into `lib/auth` and
  // close an import cycle back through `lib/workspaces` (see that hook's own
  // note), so the enforcement points are the create-workspace action and this
  // resolver — which every authed request goes through.
  it('a newly registered account has exactly one project, named for its workspace', async () => {
    await auth.api.signUpEmail({
      body: { email: 'alice@example.com', password: 'hunter2hunter2', name: 'Alice' },
      headers: { origin: BASE_URL },
    });

    const user = await adminDb.user.findUnique({ where: { email: 'alice@example.com' } });
    const workspace = await firstWorkspaceOf(user!.id);

    // The first authed request — this IS the moment the criterion names.
    await projectsService.getActiveProject(user!.id, workspace.id);

    const projects = await allProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.workspaceId).toBe(workspace.id);
    expect(projects[0]!.name).toBe(workspace.name);
  });

  it('the project is COMPLETE at birth — its workflow and its board are seeded with it', async () => {
    // The seam delegates to the same in-transaction insert `createProject`
    // uses, so a seeded project is not a second, thinner kind of project. If
    // this ever fails, the two paths have diverged and the next thing a
    // project needs at birth will reach only one of them.
    await auth.api.signUpEmail({
      body: { email: 'seeded@example.com', password: 'hunter2hunter2', name: 'Seeded' },
      headers: { origin: BASE_URL },
    });
    const user = await adminDb.user.findUnique({ where: { email: 'seeded@example.com' } });
    const workspace = await firstWorkspaceOf(user!.id);
    await projectsService.getActiveProject(user!.id, workspace.id);

    const project = (await allProjects())[0]!;
    expect(
      await adminDb.workflowStatus.count({ where: { projectId: project.id } }),
    ).toBeGreaterThan(0);
    expect(await adminDb.board.count({ where: { projectId: project.id } })).toBe(1);
  });

  it('the first authed resolution finds it and PINS it as the active project', async () => {
    await auth.api.signUpEmail({
      body: { email: 'pinned@example.com', password: 'hunter2hunter2', name: 'Pinned' },
      headers: { origin: BASE_URL },
    });
    const user = await adminDb.user.findUnique({ where: { email: 'pinned@example.com' } });
    const workspace = await firstWorkspaceOf(user!.id);

    const active = await projectsService.getActiveProject(user!.id, workspace.id);
    expect(active).not.toBeNull();

    const membership = await adminDb.workspaceMembership.findFirst({
      where: { userId: user!.id, workspaceId: workspace.id },
    });
    expect(membership!.activeProjectId).toBe(active!.id);
  });
});

describe('door 2 — A WORKSPACE CREATED LATER', () => {
  it('has exactly one project when it is first resolved', async () => {
    // The door the card never named. `createWorkspace` seeds no project, so
    // before this card the org menu's "New workspace" produced the very state
    // the story deletes every handler for.
    const user = await usersService.createUser({
      email: 'second@example.com',
      password: 'hunter2hunter2',
      name: 'Second',
    });
    const { workspace: first } = await workspacesService.ensureDefaultWorkspace({
      userId: user.id,
      userName: user.name,
    });
    const { workspace: second } = await workspacesService.createWorkspace({
      name: 'Side project',
      ownerUserId: user.id,
    });
    expect(second.id).not.toBe(first.id);

    const active = await projectsService.getActiveProject(user.id, second.id);

    expect(active).not.toBeNull();
    expect(active!.name).toBe('Side project');
    const inSecond = (await allProjects()).filter((p) => p.workspaceId === second.id);
    expect(inSecond).toHaveLength(1);
  });
});

describe('door 3 — ARCHIVING THE LAST PROJECT', () => {
  it('resolves to a project again on the next read, rather than to null', async () => {
    const user = await usersService.createUser({
      email: 'archiver@example.com',
      password: 'hunter2hunter2',
      name: 'Archiver',
    });
    const { workspace } = await workspacesService.ensureDefaultWorkspace({
      userId: user.id,
      userName: user.name,
    });
    const only = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
    });

    await projectsService.archiveProject({
      projectId: only.id,
      workspaceId: workspace.id,
      actorUserId: user.id,
    });

    const active = await projectsService.getActiveProject(user.id, workspace.id);

    // This is what "you are always in a project" MEANS, and it is the one
    // place the invariant changes behaviour a reader could notice: you can no
    // more sit in a project-less workspace than in a workspace-less account.
    expect(active).not.toBeNull();
    expect(active!.id).not.toBe(only.id);
    expect(active!.archivedAt).toBeNull();
  });
});

describe('ensureDefaultProject — idempotence', () => {
  it('is a no-op when the workspace already has a project', async () => {
    const user = await usersService.createUser({
      email: 'noop@example.com',
      password: 'hunter2hunter2',
      name: 'Noop',
    });
    const { workspace } = await workspacesService.ensureDefaultWorkspace({
      userId: user.id,
      userName: user.name,
    });

    const a = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
    });
    const b = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
    });

    expect(b.id).toBe(a.id);
    expect(await allProjects()).toHaveLength(1);
  });

  it('survives a CONCURRENT double-submit — two parallel calls create ONE project', async () => {
    const user = await usersService.createUser({
      email: 'race@example.com',
      password: 'hunter2hunter2',
      name: 'Race',
    });
    const { workspace } = await workspacesService.ensureDefaultWorkspace({
      userId: user.id,
      userName: user.name,
    });

    // Two browser tabs right after signup. The FOR UPDATE lock on the
    // WORKSPACE row serialises them: the second blocks, re-reads a non-empty
    // list inside the lock, and returns the first caller's project.
    const [a, b] = await Promise.all([
      projectsService.ensureDefaultProject({ workspaceId: workspace.id, actorUserId: user.id }),
      projectsService.ensureDefaultProject({ workspaceId: workspace.id, actorUserId: user.id }),
    ]);

    expect(a.id).toBe(b.id);
    expect(await allProjects()).toHaveLength(1);
  });

  it('the idempotency read is CONTEXT-BOUND, so it cannot fail open under RLS', async () => {
    // ⚠️ The guard that matters most, and the one a green suite hides under
    // the BYPASSRLS dev role. `project`'s RLS policy gates on
    // `app.workspace_id`; an unbound read returns zero rows for a workspace
    // that HAS projects — RLS removes rows, it does not raise — so the
    // idempotency check would fail OPEN and mint a duplicate on every call.
    // That is MOTIR-2874 exactly, one tier down.
    //
    // Asserting it needs a fixture where the reader's view and the true
    // population DIFFER: here the project is created under ONE workspace's
    // binding and the ensure is then called for that same workspace from a
    // caller that has resolved nothing. Under `TEST_DB_APP_ROLE=1` an unbound
    // implementation returns a SECOND project; bound, it returns the first.
    const user = await usersService.createUser({
      email: 'rls@example.com',
      password: 'hunter2hunter2',
      name: 'Rls',
    });
    const { workspace } = await workspacesService.ensureDefaultWorkspace({
      userId: user.id,
      userName: user.name,
    });
    const seeded = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Already here',
    });

    const ensured = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
    });

    expect(ensured.id).toBe(seeded.id);
    expect(await allProjects()).toHaveLength(1);
  });

  it('refuses a caller who is not a member of the workspace', async () => {
    const owner = await usersService.createUser({
      email: 'owner@example.com',
      password: 'hunter2hunter2',
      name: 'Owner',
    });
    const stranger = await usersService.createUser({
      email: 'stranger@example.com',
      password: 'hunter2hunter2',
      name: 'Stranger',
    });
    const { workspace } = await workspacesService.ensureDefaultWorkspace({
      userId: owner.id,
      userName: owner.name,
    });

    await expect(
      projectsService.ensureDefaultProject({
        workspaceId: workspace.id,
        actorUserId: stranger.id,
      }),
    ).rejects.toThrow();
    expect(await allProjects()).toHaveLength(0);
  });
});

describe('getActiveProject — the null that SURVIVES', () => {
  it('still returns null for an actor who is not a member — the heal must not paper over it', async () => {
    // The invariant is "a MEMBER is always in a project", not "every read
    // returns a project". Healing this null would mint a project in a
    // workspace on behalf of someone with no membership in it, which is a
    // tenancy hole rather than a convenience.
    const owner = await usersService.createUser({
      email: 'member@example.com',
      password: 'hunter2hunter2',
      name: 'Member',
    });
    const stranger = await usersService.createUser({
      email: 'outsider@example.com',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    const { workspace } = await workspacesService.ensureDefaultWorkspace({
      userId: owner.id,
      userName: owner.name,
    });

    const active = await projectsService.getActiveProject(stranger.id, workspace.id);

    expect(active).toBeNull();
    expect(await allProjects()).toHaveLength(0);
  });
});
