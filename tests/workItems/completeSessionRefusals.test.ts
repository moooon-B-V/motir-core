import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-3364 — ONE REFUSED CARD MUST NOT TAKE THE WHOLE BRANCH DOWN.
//
// `completeSession` closes every card a run integrated onto one session branch
// (MOTIR-3007), and it does so inside a SINGLE `withWorkspaceContext`
// transaction. Its per-item catch listed three error classes by hand and
// rethrew everything else — so an artifact-evidence refusal (MOTIR-2709,
// shipped three days after that catch was last touched) escaped the loop,
// aborted the transaction, and ROLLED BACK every sibling already closed. A
// delivery that closes N cards closed none, and reported nothing, because of a
// rule about one of them.
//
// The fix is `isStatusTransitionRefusal`, shared with the merge-driven sync, so
// neither consumer can be one gate behind the authority again.
//
// ⚠️ SCOPE NOTE, so a later reader does not go looking for a case that cannot
// exist: `ContainerHasOpenChildrenError` is in the refusal set and is NOT
// reachable from here. That gate fires only on the container-CLAIM statuses
// (`implemented` / `in_review`) and `done` is deliberately unguarded — completing
// a parent is a decision that completes its children. It is covered by the
// predicate so a future target-status change inherits it, and asserted at the
// predicate in `statusTransitionRefusals.test.ts` rather than faked here.
//
// Real Postgres, per the repo convention.

const PASSWORD = 'hunter2hunter2';
const SESSION_BRANCH = 'motir/auto-20260821-115500';

let seq = 0;

async function makeProject() {
  seq += 1;
  const user = await usersService.createUser({
    email: `csr-${seq}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `CSR ${seq}`,
    ownerUserId: user.id,
  });
  const ctx: ServiceContext = { userId: user.id, workspaceId: workspace.id };
  const project = await createTestProject({ workspaceId: workspace.id, actorUserId: user.id });
  return { ctx, projectId: project.id };
}

/** A card the run integrated onto the session branch — `markIntegrated` is the
 *  shipped seam that stamps `session_branch` and parks the item at Implemented. */
async function integrated(
  projectId: string,
  ctx: ServiceContext,
  title: string,
  type: 'deploy' | 'code',
) {
  const item = await workItemsService.createWorkItem({ projectId, kind: 'task', title, type }, ctx);
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  await workItemsService.markIntegrated(item.id, SESSION_BRANCH, ctx);
  return item;
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('completeSession — a per-item refusal is reported, never fatal', () => {
  it('closes the siblings and reports the refused card, instead of rolling the whole branch back', async () => {
    const { ctx, projectId } = await makeProject();
    const release = await integrated(projectId, ctx, 'Cut the release', 'deploy');
    const before = await integrated(projectId, ctx, 'Wire the route', 'code');
    const after = await integrated(projectId, ctx, 'Add the migration', 'code');

    const result = await workItemsService.completeSession(SESSION_BRANCH, ctx);

    // The refused card is REPORTED, carrying the gate's own message so the reader
    // learns what to record rather than that "something failed".
    const byKey = Object.fromEntries(result.results.map((r) => [r.key, r]));
    expect(byKey[release.identifier]).toMatchObject({ outcome: 'failed' });
    expect(byKey[release.identifier]!.reason).toContain('deploy');

    // …and BOTH siblings closed. This is the assertion the bug was about: the
    // rethrow aborted the transaction, so a card the loop had already closed —
    // `before`, which precedes the refusal — was rolled back with it.
    expect(byKey[before.identifier]).toMatchObject({ outcome: 'completed' });
    expect(byKey[after.identifier]).toMatchObject({ outcome: 'completed' });
    expect(await statusOf(before.id)).toBe('done');
    expect(await statusOf(after.id)).toBe('done');

    // The refused card did not move, and keeps its branch — so re-running the
    // close-out after somebody records the artifact still finds it.
    expect(await statusOf(release.id)).toBe('implemented');
    const row = await adminDb.workItem.findUnique({ where: { id: release.id } });
    expect(row!.sessionBranch).toBe(SESSION_BRANCH);
  });

  it('a delivery that closes N cards SAYS N — the refusal does not hide the rest', async () => {
    const { ctx, projectId } = await makeProject();
    await integrated(projectId, ctx, 'Cut the release', 'deploy');
    await integrated(projectId, ctx, 'Wire the route', 'code');
    await integrated(projectId, ctx, 'Add the migration', 'code');

    const result = await workItemsService.completeSession(SESSION_BRANCH, ctx);

    expect(result.results).toHaveLength(3);
    expect(result.results.filter((r) => r.outcome === 'completed')).toHaveLength(2);
    expect(result.results.filter((r) => r.outcome === 'failed')).toHaveLength(1);
  });

  it('re-running after the artifact is recorded closes the card that was held', async () => {
    const { ctx, projectId } = await makeProject();
    const release = await integrated(projectId, ctx, 'Cut the release', 'deploy');
    const sibling = await integrated(projectId, ctx, 'Wire the route', 'code');

    await workItemsService.completeSession(SESSION_BRANCH, ctx);
    expect(await statusOf(release.id)).toBe('implemented');

    // The hold is clearable by the person it is addressed to, which is the whole
    // point of reporting it rather than throwing.
    await commentsService.addComment(
      release.id,
      { bodyMd: 'Released `sha256:446c692d1f4a9b0c2e11` — release 18.' },
      ctx,
    );
    const second = await workItemsService.completeSession(SESSION_BRANCH, ctx);

    expect(second.results).toEqual([{ key: release.identifier, outcome: 'completed' }]);
    expect(await statusOf(release.id)).toBe('done');
    // The sibling closed on the FIRST pass and is not touched again — a done card
    // clears its branch, so the second pass never sees it.
    expect(await statusOf(sibling.id)).toBe('done');
  });

  it('a branch whose ONLY card is refused closes nothing and still resolves', async () => {
    const { ctx, projectId } = await makeProject();
    const release = await integrated(projectId, ctx, 'Cut the release', 'deploy');

    const result = await workItemsService.completeSession(SESSION_BRANCH, ctx);

    expect(result.results).toEqual([
      { key: release.identifier, outcome: 'failed', reason: expect.stringContaining('deploy') },
    ]);
    expect(await statusOf(release.id)).toBe('implemented');
  });
});
