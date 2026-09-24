import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A typed refusal no arm of an item-page Server Action maps is answered IN
// PLACE, and still reported (MOTIR-6147). Before, the action rethrew it: the
// browser got a 500 and the generic "error occurred in the Server Components
// render", and `dropExpectedDomainErrors` dropped the server's report because
// the error was a typed 4xx — so production had two actions 500ing with no
// server-side event at all.
//
// The refusal driven here is a real one: a project VIEWER can browse the item
// (the action's `getWorkItem` gate passes) and cannot edit it, so the service
// throws `ProjectAccessDeniedError` — a typed 4xx the two actions do not map.
// Real Postgres through the real services; only the session, the active
// project and Sentry's capture are stubbed.
const { session, activeCtx, sentry } = vi.hoisted(() => {
  const scope = { setLevel: vi.fn(), setTag: vi.fn(), setContext: vi.fn() };
  return {
    session: { current: null as unknown },
    activeCtx: { current: null as unknown },
    sentry: {
      scope,
      captureException: vi.fn(),
      withScope: vi.fn((cb: (s: typeof scope) => void) => cb(scope)),
    },
  };
});
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('@sentry/nextjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/nextjs')>()),
  captureException: sentry.captureException,
  withScope: sentry.withScope,
}));

import { db } from '@/lib/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { changeStatusAction, updateIssueAction } from '@/app/(authed)/items/[key]/edit/actions';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  sentry.captureException.mockReset();
  sentry.scope.setLevel.mockReset();
  sentry.scope.setTag.mockReset();
  sentry.scope.setContext.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A task in the fixture's project, and a workspace member who may only VIEW it. */
async function viewerAndItem(fx: WorkItemFixture) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Not yours to change' },
    fx.ctx,
  );
  const viewer = await createTestUser({ email: 'refusal-viewer@ex.com', name: 'Viewer' });
  await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
  await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    projectMembershipRepository.create(
      { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: viewer.id, role: 'viewer' },
      tx,
    ),
  );
  session.current = { user: { id: viewer.id } };
  activeCtx.current = { projectId: fx.projectId, userId: viewer.id, workspaceId: fx.workspaceId };
  return item;
}

const row = (id: string) =>
  adminDb.workItem.findUniqueOrThrow({ where: { id }, select: { priority: true, status: true } });

function expectReported(action: string) {
  expect(sentry.captureException).toHaveBeenCalledTimes(1);
  expect(sentry.scope.setLevel).toHaveBeenCalledWith('warning');
  expect(sentry.scope.setTag).toHaveBeenCalledWith(
    'unmapped_action_refusal',
    'PROJECT_ACCESS_DENIED',
  );
  expect(sentry.scope.setContext).toHaveBeenCalledWith('server_action', {
    action,
    code: 'PROJECT_ACCESS_DENIED',
  });
}

describe('an unmapped typed refusal is answered in place, not as a 500 (MOTIR-6147)', () => {
  it('updateIssueAction returns the refusal as a message and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const item = await viewerAndItem(fx);
    const before = await row(item.id);

    const result = await updateIssueAction({ id: item.id, priority: 'highest' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^That didn’t go through: /);
    await expect(row(item.id)).resolves.toEqual(before);
    expectReported('updateIssueAction');
  });

  it('changeStatusAction returns the refusal as a message and moves nothing', async () => {
    const fx = await makeWorkItemFixture();
    const item = await viewerAndItem(fx);
    const before = await row(item.id);

    const result = await changeStatusAction({ id: item.id, toStatusKey: 'in_progress' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^That didn’t go through: /);
    await expect(row(item.id)).resolves.toEqual(before);
    expectReported('changeStatusAction');
  });

  it('a MAPPED refusal keeps its own wording and reports nothing', async () => {
    const fx = await makeWorkItemFixture();
    session.current = { user: { id: fx.ownerId } };
    activeCtx.current = {
      projectId: fx.projectId,
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
    };
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Mapped' },
      fx.ctx,
    );

    const result = await changeStatusAction({ id: item.id, toStatusKey: 'no_such_status' });

    expect(result).toMatchObject({ ok: false, field: 'status' });
    if (result.ok) return;
    expect(result.error).not.toMatch(/^That didn’t go through/);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
