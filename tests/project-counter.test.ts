import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Focused unit test for the gap-free per-project work-item counter
// (Subtask 1.3.1). The comprehensive CRUD/uniqueness suite is Subtask
// 1.3.5; this proves only the counter contract. Real Postgres, no mocks.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeWorkspaceWithProject(email: string, name: string, identifier?: string) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `${name} WS`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name,
    identifier,
  });
  return { userId: user.id, workspaceId: workspace.id, projectId: project.id };
}

type Fixture = Awaited<ReturnType<typeof makeWorkspaceWithProject>>;

/**
 * The workspace context production allocates under.
 *
 * `allocateWorkItemNumber` is a repository method, and every production caller
 * reaches it through `withWorkspaceContext` — the service layer opens the
 * transaction and binds the GUCs the `project` policy reads. A bare
 * `db.$transaction` reaches the same method with no tenant bound, which was
 * invisible while the test connection bypassed RLS and is a denied read once it
 * does not. The repository stays the code under test on `@/lib/db`; only the
 * transaction it is handed now matches the one it gets in production.
 */
function ctxOf(fx: Fixture) {
  return { userId: fx.userId, workspaceId: fx.workspaceId };
}

describe('allocateWorkItemNumber', () => {
  it('returns sequential, gap-free numbers (1, 2, 3, …)', async () => {
    const fx = await makeWorkspaceWithProject('owner@example.com', 'Motir Core');
    const { projectId } = fx;
    const ctx = ctxOf(fx);

    const n1 = await withWorkspaceContext(ctx, (tx) =>
      projectRepository.allocateWorkItemNumber(projectId, tx),
    );
    const n2 = await withWorkspaceContext(ctx, (tx) =>
      projectRepository.allocateWorkItemNumber(projectId, tx),
    );
    const n3 = await withWorkspaceContext(ctx, (tx) =>
      projectRepository.allocateWorkItemNumber(projectId, tx),
    );

    expect([n1, n2, n3]).toEqual([1, 2, 3]);

    const row = await adminDb.project.findUnique({ where: { id: projectId } });
    expect(row?.lastWorkItemNumber).toBe(3);
  });

  it('keeps each project on an independent counter', async () => {
    const a = await makeWorkspaceWithProject('a@example.com', 'Apollo', 'APOL');
    const b = await makeWorkspaceWithProject('b@example.com', 'Beacon', 'BEAC');

    // Interleave allocations across the two projects.
    const a1 = await withWorkspaceContext(ctxOf(a), (tx) =>
      projectRepository.allocateWorkItemNumber(a.projectId, tx),
    );
    const b1 = await withWorkspaceContext(ctxOf(b), (tx) =>
      projectRepository.allocateWorkItemNumber(b.projectId, tx),
    );
    const a2 = await withWorkspaceContext(ctxOf(a), (tx) =>
      projectRepository.allocateWorkItemNumber(a.projectId, tx),
    );
    const b2 = await withWorkspaceContext(ctxOf(b), (tx) =>
      projectRepository.allocateWorkItemNumber(b.projectId, tx),
    );
    const a3 = await withWorkspaceContext(ctxOf(a), (tx) =>
      projectRepository.allocateWorkItemNumber(a.projectId, tx),
    );

    expect([a1, a2, a3]).toEqual([1, 2, 3]);
    expect([b1, b2]).toEqual([1, 2]);
  });

  it('is gap-free under concurrent allocation', async () => {
    const fx = await makeWorkspaceWithProject('owner@example.com', 'Motir Core');
    const { projectId } = fx;
    const ctx = ctxOf(fx);

    // Fire 20 allocations concurrently. UPDATE … RETURNING serializes on the
    // row, so the set of returned numbers must be exactly {1..20} with no
    // gaps and no duplicates.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        withWorkspaceContext(ctx, (tx) => projectRepository.allocateWorkItemNumber(projectId, tx)),
      ),
    );

    const sorted = [...results].sort((x, y) => x - y);
    expect(sorted).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(results).size).toBe(20);
  });
});
