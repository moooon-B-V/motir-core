import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { childStatusCascadeService } from '@/lib/services/childStatusCascadeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { UnknownStatusError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// `childStatusCascadeService.cascadeToChildren` — the DOWNWARD half of
// bidirectional status derivation (Story MOTIR-1615 · Subtask MOTIR-1647). Real
// Postgres.
//
// The headline property: a `todo` child is forced to `done` even though the
// default workflow has NO `todo → done` edge. That is the privileged system set,
// and the test that proves it is also the test that would catch someone
// "fixing" the cascade by adding user-draggable transition rows — because the
// legality check is asserted to still reject that move for a user.
//
// The event emitter is mocked: its emission is what carries the cascade to
// grandchildren (wired by MOTIR-1621), and asserting it here pins the recursion's
// termination condition without needing the job runtime.

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

beforeEach(async () => {
  await truncateAuthTables();
  sent.length = 0;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function setStatus(id: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

/**
 * The TRANSITION that woke the cascade. Since MOTIR-2957 the trigger is read off
 * the event, not off the row — see `CascadeTrigger`. Every test that puts a parent
 * IN a done status is describing a parent that has just ENTERED one, so this is
 * the default; the tests about the trigger itself pass their own.
 */
const ENTERED_DONE = { fromStatusKey: 'in_progress', toStatusKey: 'done' } as const;

/** `cascadeToChildren` with the entered-done trigger unless a test names another. */
async function cascade(
  itemId: string,
  workspaceId: string,
  trigger: { fromStatusKey: string; toStatusKey: string } = ENTERED_DONE,
) {
  return childStatusCascadeService.cascadeToChildren(itemId, workspaceId, trigger);
}

/** A done story over children in the given statuses. */
async function doneStoryWithChildren(fx: WorkItemFixture, statuses: string[]) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Parent' });
  await setStatus(story.id, 'done');
  const children = [];
  for (const [i, s] of statuses.entries()) {
    const c = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: `child ${i}`,
      parentId: story.id,
    });
    await setStatus(c.id, s);
    children.push(c);
  }
  return { story, children };
}

describe('the cascade — a done parent completes its children', () => {
  it('forces a TODO child to done, a move no legal user transition allows', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo']);

    const res = await cascade(story.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'cascaded', toStatus: 'done' });
    expect(await statusOf(children[0]!.id)).toBe('done');

    // …and the ordinary user path still refuses that same move, so the cascade
    // did NOT buy its power by adding a user-draggable edge.
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((s) => s.key === k)!.id;
    const userEdge = await adminDb.workflowTransition.findFirst({
      where: {
        projectId: fx.projectId,
        fromStatusId: idOf('todo'),
        toStatusId: idOf('done'),
      },
    });
    expect(userEdge).toBeNull();
  });

  it('forces a BLOCKED child too, and completes several children in one pass', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, [
      'blocked',
      'in_progress',
      'in_review',
    ]);

    const res = await cascade(story.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'cascaded' });
    expect((res as { childIds: string[] }).childIds).toHaveLength(3);
    for (const c of children) expect(await statusOf(c.id)).toBe('done');
  });

  it('keeps the done invariants: a revision per child, and sessionBranch cleared', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['in_review']);
    await adminDb.workItem.update({
      where: { id: children[0]!.id },
      data: { sessionBranch: 'motir/auto-1' },
    });

    await cascade(story.id, fx.workspaceId);

    const child = await adminDb.workItem.findUniqueOrThrow({ where: { id: children[0]!.id } });
    expect(child.status).toBe('done');
    // The system set skips ONLY the legality check — every other invariant holds.
    expect(child.sessionBranch).toBeNull();

    const revs = await adminDb.workItemRevision.findMany({
      where: { workItemId: children[0]!.id },
      orderBy: { changedAt: 'desc' },
    });
    expect(revs[0]!.changeKind).toBe('updated');
    expect((revs[0]!.diff as Record<string, unknown>)['status']).toEqual({
      from: 'in_review',
      to: 'done',
    });
    expect(revs[0]!.changedById).toBe(fx.ownerId);
  });

  it('cascades from an EPIC to its stories', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await setStatus(epic.id, 'done');
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Story',
      parentId: epic.id,
    });
    await setStatus(story.id, 'todo');

    await cascade(epic.id, fx.workspaceId);
    expect(await statusOf(story.id)).toBe('done');
  });

  it('touches DIRECT children only — the grandchild waits for its own event', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    await setStatus(story.id, 'done');
    const task = await createTestWorkItem(fx, { kind: 'task', title: 'Mid', parentId: story.id });
    await setStatus(task.id, 'todo');
    const leaf = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Leaf',
      parentId: task.id,
    });
    await setStatus(leaf.id, 'todo');

    await cascade(story.id, fx.workspaceId);

    expect(await statusOf(task.id)).toBe('done');
    // Untouched by THIS pass — it is reached by the event emitted for `task`.
    expect(await statusOf(leaf.id)).toBe('todo');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({ workItemId: task.id, toStatusKey: 'done' });
  });
});

// The cascade's trigger is unchanged by MOTIR-2888: it fires only on ENTRY into a
// done-category status, never on exit. That is what keeps a parent which has just
// come BACK to todo from force-closing the child that brought it there.
//
// What MOTIR-2957 changed is WHERE that entry is read from — the transition the
// event carries, not the item's current status. The two agree except when a
// concurrent derivation has moved the row in between, which is the one case rung 4
// made common. Every test below therefore states its own trigger where the trigger
// is the subject.
describe('entry-triggered only, gates, and no-ops', () => {
  it('a NON-done transition is a clean no-op (the trigger is entry into done)', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo']);
    await setStatus(story.id, 'in_progress');

    expect(
      await cascade(story.id, fx.workspaceId, {
        fromStatusKey: 'todo',
        toStatusKey: 'in_progress',
      }),
    ).toEqual({
      outcome: 'not_done',
    });
    expect(await statusOf(children[0]!.id)).toBe('todo');
    expect(sent).toHaveLength(0);
  });

  it('a parent LEAVING done cascades nothing — the exit is not an entry', async () => {
    // ADR §5's termination argument, part 2, asserted directly: the one motion
    // rung 4 introduced (a parent coming BACK) must start no downward wave, or a
    // parent that has just returned to `todo` would force-close the very child
    // that brought it there.
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo']);
    await setStatus(story.id, 'todo');

    expect(
      await cascade(story.id, fx.workspaceId, { fromStatusKey: 'done', toStatusKey: 'todo' }),
    ).toEqual({ outcome: 'not_done' });
    expect(await statusOf(children[0]!.id)).toBe('todo');
    expect(sent).toHaveLength(0);
  });

  it('a move WITHIN the done category is not an entry either', async () => {
    // `done → cancelled` leaves the parent terminal throughout, so there is no
    // entry to act on — and re-cascading would re-touch children a previous pass
    // already settled.
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo']);
    await setStatus(story.id, 'cancelled');

    expect(
      await cascade(story.id, fx.workspaceId, { fromStatusKey: 'done', toStatusKey: 'cancelled' }),
    ).toEqual({ outcome: 'not_done' });
    expect(await statusOf(children[0]!.id)).toBe('todo');
  });

  it('a CANCELLED parent cascades too — cancelled is a done-category status', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo']);
    await setStatus(story.id, 'cancelled');

    expect(
      await cascade(story.id, fx.workspaceId, {
        fromStatusKey: 'in_progress',
        toStatusKey: 'cancelled',
      }),
    ).toMatchObject({
      outcome: 'cascaded',
    });
    expect(await statusOf(children[0]!.id)).toBe('done');
  });

  it('⚠️ the ROW may already have moved on — the cascade still fires (MOTIR-2957)', async () => {
    // THE REGRESSION. The trigger used to be tested by re-reading the item, and a
    // rung-4 recompute racing in from a sibling `work-item/created` job — for a
    // child created moments BEFORE the parent was set Done — moves the parent to
    // `todo` in exactly this window. The row read then answered `not_done`, the
    // cascade never ran, the child set never changed again, and the user's Done was
    // gone for good: measured 7 times in 20 against `origin/main` @ `a09c21ee`.
    //
    // The state below IS that interleaving, frozen: the transition says the parent
    // entered `done`, and the row already says `todo`.
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo']);
    await setStatus(story.id, 'todo');

    const res = await cascade(story.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'cascaded', toStatus: 'done' });
    expect(await statusOf(children[0]!.id)).toBe('done');
    // And the emission that carries the recompute back up — the parent's children
    // are now all done, so rung 1 returns it to `done` and the pair reaches the
    // fixed point ADR §5 part 2 describes.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: 'work-item/transitioned' });
  });

  it('already-done children are never re-touched, and nothing is emitted', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['done', 'cancelled']);

    const res = await cascade(story.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'no_open_children', itemId: story.id });
    // A cancelled child keeps the terminal status its team chose.
    expect(await statusOf(children[1]!.id)).toBe('cancelled');
    expect(sent).toHaveLength(0);
  });

  it('a LEAF item with no children is a clean no-op', async () => {
    const fx = await makeWorkItemFixture();
    const leaf = await createTestWorkItem(fx, { kind: 'story', title: 'Leaf' });
    await setStatus(leaf.id, 'done');

    expect(await cascade(leaf.id, fx.workspaceId)).toEqual({
      outcome: 'no_open_children',
      itemId: leaf.id,
    });
  });

  it('the toggle OFF suppresses the cascade entirely', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo']);
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { autoCompleteChildrenOnParentDone: false },
    });

    expect(await cascade(story.id, fx.workspaceId)).toEqual({
      outcome: 'toggle_off',
      itemId: story.id,
    });
    expect(await statusOf(children[0]!.id)).toBe('todo');
  });

  it('the UPWARD toggle does not suppress the downward cascade', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo']);
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { autoRollupParentStatus: false },
    });

    expect(await cascade(story.id, fx.workspaceId)).toMatchObject({
      outcome: 'cascaded',
    });
    expect(await statusOf(children[0]!.id)).toBe('done');
  });

  it('archived and triage children are left out of the cascade', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo', 'todo']);
    await adminDb.workItem.update({
      where: { id: children[1]!.id },
      data: { archivedAt: new Date() },
    });

    const res = await cascade(story.id, fx.workspaceId);

    expect((res as { childIds: string[] }).childIds).toEqual([children[0]!.id]);
    // An archived child must not be resurrected into `done`.
    expect(await statusOf(children[1]!.id)).toBe('todo');
  });

  it('an unknown item id is a clean no-op', async () => {
    const fx = await makeWorkItemFixture();
    expect(await cascade('nope', fx.workspaceId)).toEqual({
      outcome: 'unresolvable',
    });
  });
});

describe('the two directions cannot loop', () => {
  it('a parent reaching done by cascade already has every child done', async () => {
    // The non-interference argument in one assertion: after the cascade, the
    // upward rollup over the same parent has nothing left to do, because the
    // parent is already in the status the done rung would target.
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo', 'in_progress']);

    await cascade(story.id, fx.workspaceId);

    for (const c of children) expect(await statusOf(c.id)).toBe('done');
    expect(await statusOf(story.id)).toBe('done');

    // Re-running the cascade is idempotent — no children left open, no events.
    sent.length = 0;
    expect(await cascade(story.id, fx.workspaceId)).toMatchObject({
      outcome: 'no_open_children',
    });
    expect(sent).toHaveLength(0);
  });
});

describe('defensive error routing — the job must never fail behind a user transition', () => {
  // The done key is resolved before the write, so a status deleted (or a
  // permission revoked) in that window surfaces from `applyStatusTransition`.
  // What is under test is the ROUTING — a typed no-op instead of a propagated
  // error — not the race itself.

  async function forceWriteError(err: Error) {
    const fx = await makeWorkItemFixture();
    const { story } = await doneStoryWithChildren(fx, ['todo']);
    vi.spyOn(workItemsService, 'applyStatusTransition').mockRejectedValue(err);
    const res = await cascade(story.id, fx.workspaceId);
    vi.restoreAllMocks();
    return res;
  }

  it('an UnknownStatusError reads as no_matching_status', async () => {
    expect(await forceWriteError(new UnknownStatusError('ghost'))).toMatchObject({
      outcome: 'no_matching_status',
    });
  });

  it('a ProjectAccessDeniedError reads as access_denied', async () => {
    expect(await forceWriteError(new ProjectAccessDeniedError('p1', 'edit'))).toMatchObject({
      outcome: 'access_denied',
    });
  });

  it('a ProjectNotFoundError reads as access_denied too', async () => {
    expect(await forceWriteError(new ProjectNotFoundError('p1'))).toMatchObject({
      outcome: 'access_denied',
    });
  });

  it('an UNEXPECTED error still propagates — a real fault is not swallowed', async () => {
    await expect(forceWriteError(new Error('disk on fire'))).rejects.toThrow('disk on fire');
  });

  it('a project with no done-category status at all is a logged no-op', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo']);
    // The resolver finds nothing to cascade TO — a custom workflow that dropped
    // its done statuses. Forced at the resolver rather than by deleting the
    // statuses, which the workflow service protects.
    vi.spyOn(workflowsService, 'resolveStatusKey').mockResolvedValue(null);

    expect(await cascade(story.id, fx.workspaceId)).toEqual({
      outcome: 'no_matching_status',
      itemId: story.id,
    });
    vi.restoreAllMocks();
    expect(await statusOf(children[0]!.id)).toBe('todo');
  });
});

describe('phase 1 binds the WORKSPACE, not the system flag (MOTIR-2880)', () => {
  // ⚠️ REPRODUCE-BEFORE-FIX — the exact mirror of the rollup's case, and the same
  // one mechanism. Phase 1 used to open a `withSystemContext`, whose single GUC
  // `app.system_admin` no `work_item` or `workspace_membership` policy reads, so
  // under `motir_app` `findById(itemId)` returned NULL and EVERY cascade answered
  // `{ outcome: 'unresolvable' }` — silently, because an RLS-denied SELECT returns
  // fewer rows rather than raising.
  //
  // Since MOTIR-2734 retired `TEST_DB_APP_ROLE`, `@/lib/db` is always `motir_app`,
  // so these cases bite on every run. They were red on `main` before MOTIR-2880
  // and trivially green under the old bypass-role default.

  it('completes the children under the non-bypass role — the read is workspace-bound', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await doneStoryWithChildren(fx, ['todo']);

    const res = await cascade(story.id, fx.workspaceId);

    // On `main` before MOTIR-2880 this was `{ outcome: 'unresolvable' }`.
    expect(res).toMatchObject({ outcome: 'cascaded', toStatus: 'done' });
    expect(await statusOf(children[0]!.id)).toBe('done');
  });

  it('a FOREIGN workspaceId resolves nothing — the binding is real, not decorative', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ identifier: 'OTHR' });
    const { story, children } = await doneStoryWithChildren(fx, ['todo']);

    const res = await cascade(story.id, other.workspaceId);

    expect(res).toEqual({ outcome: 'unresolvable' });
    expect(await statusOf(children[0]!.id)).toBe('todo');
  });
});
