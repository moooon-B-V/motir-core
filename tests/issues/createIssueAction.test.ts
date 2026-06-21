import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { truncateAuthTables } from '../helpers/db';
import type { ProjectContext } from '@/lib/projects';

// createIssueAction (Subtask 2.3.3) — the thin Server Action over the shipped
// `workItemsService.createWorkItem`. Real Postgres. We stub only the two
// session/context resolvers the test env can't supply via cookies (getSession,
// getActiveProject) plus next/cache's revalidatePath (no request scope under
// vitest) — every DB write goes through the real service. The service's own
// behavior (key allocation, initial status, revision) is covered by 1.4.x; this
// asserts the TRANSPORT contract: right DTO in, reporter forced to the session
// user, typed errors mapped, created identifier out.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Import AFTER the mocks are registered.
const { createIssueAction } = await import('@/app/(authed)/items/actions');

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  userId: string;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: 'create-issue@example.com',
    password: 'hunter2hunter2',
    name: 'Issue Owner',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Issues WS', ownerUserId: owner.id });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: 'Workflow Demo',
    identifier: 'WFD',
  });
  const fx = { userId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
  session.current = {
    user: { id: owner.id, email: 'create-issue@example.com', name: 'Issue Owner' },
  };
  activeCtx.current = {
    userId: fx.userId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project,
  };
  return fx;
}

describe('createIssueAction', () => {
  it('creates a work item and returns its identifier; reporter = session user', async () => {
    const fx = await makeFixture();

    const result = await createIssueAction({
      kind: 'task',
      title: 'First issue',
      priority: 'high',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.identifier).toBe('WFD-1');

    const row = await db.workItem.findUnique({ where: { id: result.id } });
    expect(row).not.toBeNull();
    expect(row!.title).toBe('First issue');
    expect(row!.kind).toBe('task');
    expect(row!.priority).toBe('high');
    expect(row!.reporterId).toBe(fx.userId); // forced from the session
    expect(row!.parentId).toBeNull(); // top-level (no parent field yet)
  });

  it('IGNORES a client-forged reporterId — the reporter is always the session user', async () => {
    const fx = await makeFixture();
    const intruder = await usersService.createUser({
      email: 'intruder@example.com',
      password: 'hunter2hunter2',
      name: 'Intruder',
    });

    // A forged payload carrying reporterId — the action's typed input has no
    // such field, so it must never reach the service.
    const result = await createIssueAction({
      kind: 'task',
      title: 'Forged',
      reporterId: intruder.id,
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const row = await db.workItem.findUnique({ where: { id: result.id } });
    expect(row!.reporterId).toBe(fx.userId);
    expect(row!.reporterId).not.toBe(intruder.id);
  });

  it('trims the title and rejects an empty one without calling the service', async () => {
    await makeFixture();
    const empty = await createIssueAction({ kind: 'task', title: '   ' });
    expect(empty).toEqual({ ok: false, error: 'Give the work item a title.' });
    const count = await db.workItem.count();
    expect(count).toBe(0);
  });

  it('rejects a title over 200 characters', async () => {
    await makeFixture();
    const result = await createIssueAction({ kind: 'task', title: 'x'.repeat(201) });
    expect(result.ok).toBe(false);
    expect(await db.workItem.count()).toBe(0);
  });

  it('returns an error (no throw) when there is no active project', async () => {
    session.current = { user: { id: 'u', email: 'x@example.com', name: 'X' } };
    activeCtx.current = null;
    const result = await createIssueAction({ kind: 'task', title: 'Orphan' });
    expect(result.ok).toBe(false);
  });

  it('propagates a typed service error (stale project → ProjectNotFound) as a mapped message', async () => {
    const fx = await makeFixture();
    // Point the active context at a non-existent project id — the service
    // throws ProjectNotFoundError, which the action maps (not rethrows).
    activeCtx.current = { ...activeCtx.current!, projectId: 'does-not-exist' };
    const result = await createIssueAction({ kind: 'task', title: 'Ghost' });
    expect(result).toEqual({ ok: false, error: 'That project no longer exists.' });
    // Nothing persisted under the real project either.
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});
