import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { IllegalTransitionError, UnknownStatusError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';
import { isAppRoleTestMode } from '../../helpers/parallelDb';

// `parentStatusRollupService.rollUpForChild` — the UPWARD half of bidirectional
// status derivation (Story MOTIR-1615 · Subtask MOTIR-1620, AMENDED by Story
// MOTIR-2888 · Subtask MOTIR-2891). Real Postgres.
//
// It is a RECOMPUTE, not a ratchet: the parent's status is a function of its
// children's current statuses over a FOUR-rung ladder, applied forward OR
// backward. The `forward-only` describe block these tests used to carry asserted
// the opposite of the third block below, and was replaced rather than extended —
// two suites disagreeing about which way a parent may move is worse than either.
//
// The one mocked external is the event emitter: this service's post-commit
// `work-item/transitioned` is what carries derivation to the NEXT level, and the
// job that consumes it is MOTIR-1621's. Here we assert the service emits exactly
// when it really moved the parent, and never otherwise — the property that makes
// the recursion terminate.

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

/** A story with N subtasks, every status pinned explicitly (the fixture writes
 *  through the repository, which skips the service's initial-status lookup). */
async function storyWithChildren(fx: WorkItemFixture, statuses: string[]) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Parent' });
  await setStatus(story.id, 'todo');
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

describe('the ladder — each rung moves the parent to the right status', () => {
  it('in-progress rung: one child starts ⇒ a todo parent goes in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress', 'todo']);

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'rolled_up', parentId: story.id, toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('in-review rung: the LAST open child reaches review ⇒ parent in_review', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'done']);
    await setStatus(story.id, 'in_progress'); // where the previous rung left it

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'in_review' });
    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('in-review rung does NOT fire while a child is still open', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'todo']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    // The in-progress rung is the only match, and the parent is already there.
    expect(res).toMatchObject({ outcome: 'already_there' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('done rung: every child done ⇒ parent done, straight from in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    // This is the move MOTIR-1625's in_progress → done edge exists for.
    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('done');
  });

  it('a CANCELLED child counts as done (category, not key)', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'cancelled']);
    await setStatus(story.id, 'in_progress');

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(await statusOf(story.id)).toBe('done');
  });

  it('the done rung beats the in-review rung when both could match', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_review');

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(await statusOf(story.id)).toBe('done');
  });

  it('rolls up an EPIC from its stories, not just a story from its subtasks', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await setStatus(epic.id, 'todo');
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Story',
      parentId: epic.id,
    });
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(story.id, fx.workspaceId);
    expect(res).toMatchObject({ outcome: 'rolled_up', parentId: epic.id });
    expect(await statusOf(epic.id)).toBe('in_progress');
  });
});

describe('the fourth (todo) rung — the ladder can say "open work, none started"', () => {
  it('a DONE parent given a fresh todo child comes back to todo', async () => {
    // The story's own case (MOTIR-2888), and the one the ratchet could not
    // express: `done → todo` is not an edge in the default workflow, so this
    // lands only via the backward arm's system set.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done', 'todo']);
    await setStatus(story.id, 'done');

    const res = await parentStatusRollupService.rollUpForChild(children[2]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_back', parentId: story.id, toStatus: 'todo' });
    expect(await statusOf(story.id)).toBe('todo');
  });

  it('an all-todo parent already in todo is the OTHER fixed point — no move, no emit', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo', 'blocked']);

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'already_there', parentId: story.id, toStatus: 'todo' });
    expect(await statusOf(story.id)).toBe('todo');
    expect(sent).toHaveLength(0);
  });

  it('does NOT fire on an empty aggregate — a childless parent is untouched', async () => {
    // The mirror of "every child is done must not be vacuously true": creating a
    // story must not knock its epic back to todo.
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await setStatus(epic.id, 'done');
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Story',
      parentId: epic.id,
    });
    await setStatus(story.id, 'done');
    // Every live child of the STORY is archived, so its own aggregate is empty.
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'archived child',
      parentId: story.id,
    });
    await setStatus(child.id, 'todo');
    await adminDb.workItem.update({ where: { id: child.id }, data: { archivedAt: new Date() } });

    const res = await parentStatusRollupService.rollUpForChild(child.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'no_rung', parentId: story.id });
    expect(await statusOf(story.id)).toBe('done');
    expect(sent).toHaveLength(0);
  });

  it('leaves a BLOCKED parent alone — same rung, and blocked is a human marker', async () => {
    // `blocked` and `todo` share the todo category, so the todo rung ranks level
    // with where the parent stands. `blocked → todo` IS a legal edge, so treating
    // the tie as a forward move would silently clear the marker on every child
    // event. It is neither forward nor backward: nothing moves.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo', 'todo']);
    await setStatus(story.id, 'blocked');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'same_rung', parentId: story.id, toStatus: 'todo' });
    expect(await statusOf(story.id)).toBe('blocked');
    expect(sent).toHaveLength(0);
  });
});

describe('the recompute comes BACK — every rung, from a done parent', () => {
  it('a child reopening done → in_progress DOES bring the parent back', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress', 'done']);
    await setStatus(story.id, 'done'); // the parent had already completed

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_back', toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
    expect(sent).toHaveLength(1);
  });

  it('a done parent whose last child moves to review comes back to in_review', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'in_review']);
    await setStatus(story.id, 'done');

    const res = await parentStatusRollupService.rollUpForChild(children[1]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_back', toStatus: 'in_review' });
    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('an in_review parent IS dragged back to in_progress when a child restarts', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress', 'in_review']);
    await setStatus(story.id, 'in_review');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(res).toMatchObject({ outcome: 'rolled_back', toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('an all-done parent already done stays put — no move, no emit', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'done');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'already_there', parentId: story.id, toStatus: 'done' });
    expect(sent).toHaveLength(0);
  });

  it('a backward move lands WITHOUT a workflow edge, and still writes a revision + emits', async () => {
    // The whole reason the backward arm is a `{ system: true }` set: the default
    // workflow (restricted mode) has no `done → todo` row, and adding one would
    // make it a user-draggable board edge. The emit is what carries the recompute
    // to the grandparent, so a system set that emitted nothing would strand it.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo']);
    await setStatus(story.id, 'done');

    expect(await workflowsService.canTransition(fx.projectId, 'done', 'todo', fx.workspaceId)).toBe(
      false,
    );

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_back', toStatus: 'todo' });
    expect(await statusOf(story.id)).toBe('todo');

    const revs = await adminDb.workItemRevision.findMany({
      where: { workItemId: story.id },
      orderBy: { changedAt: 'desc' },
    });
    expect((revs[0]!.diff as Record<string, unknown>)['status']).toEqual({
      from: 'done',
      to: 'todo',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({
      workItemId: story.id,
      fromStatusKey: 'done',
      toStatusKey: 'todo',
    });
  });

  it('already in the target status is a no-op that emits nothing (recursion terminates)', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(res).toMatchObject({ outcome: 'already_there', parentId: story.id });
    expect(sent).toHaveLength(0);
  });
});

describe('gates and no-ops', () => {
  it('a top-level item with no parent is a clean no-op', async () => {
    const fx = await makeWorkItemFixture();
    const orphan = await createTestWorkItem(fx, { kind: 'story', title: 'Top level' });
    await setStatus(orphan.id, 'in_progress');

    expect(await parentStatusRollupService.rollUpForChild(orphan.id, fx.workspaceId)).toEqual({
      outcome: 'no_parent',
    });
    expect(sent).toHaveLength(0);
  });

  it('the toggle OFF suppresses the rollup entirely', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { autoRollupParentStatus: false },
    });

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(res).toEqual({ outcome: 'toggle_off', parentId: story.id });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('the DOWNWARD toggle does not suppress the upward rollup', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { autoCompleteChildrenOnParentDone: false },
    });

    expect(
      await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId),
    ).toMatchObject({
      outcome: 'rolled_up',
    });
  });

  it('an ILLEGAL move is a logged no-op, never a throw', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');
    // Remove the very edge MOTIR-1625 added, leaving the done rung unreachable
    // from in_progress — the shape a team with a custom graph can produce.
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((s) => s.key === k)!.id;
    await adminDb.workflowTransition.deleteMany({
      where: {
        projectId: fx.projectId,
        fromStatusId: idOf('in_progress'),
        toStatusId: idOf('done'),
      },
    });

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'illegal_transition', toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('in_progress'); // untouched
    expect(sent).toHaveLength(0);
  });

  it('falls to a LOWER rung when the highest one is not legal from here', async () => {
    const fx = await makeWorkItemFixture();
    // A todo parent whose only child jumps straight to review. The in-review rung
    // matches, but `todo → in_review` is not an edge. Without the fallback the
    // parent would sit in todo FOREVER — no later event changes this aggregate,
    // so it never gets another chance. (MOTIR-1623 surfaced this.)
    const { story, children } = await storyWithChildren(fx, ['in_review']);

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('the forward FALLBACK stops at the parent itself — already_there, not illegal', async () => {
    // The top rung is illegal and the next matching one is where the parent
    // already stands. That is a no-op, not a refusal, and reporting it as
    // `illegal_transition` would put a false negative in the run log.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'done']);
    await setStatus(story.id, 'in_progress');
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((s) => s.key === k)!.id;
    await adminDb.workflowTransition.deleteMany({
      where: {
        projectId: fx.projectId,
        fromStatusId: idOf('in_progress'),
        toStatusId: idOf('in_review'),
      },
    });

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'already_there', parentId: story.id, toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
    expect(sent).toHaveLength(0);
  });

  it('the forward FALLBACK never turns into a backward move', async () => {
    // A parent parked in a CUSTOM in-progress status: the in-review rung is
    // illegal from there, and the next matching rung (`in_progress`) ranks LEVEL
    // with where it stands. The fallback must end, not quietly become a system
    // set — the recompute already decided the direction from the highest rung.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'done']);
    const parked = await adminDb.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'parked',
        label: 'Parked',
        category: 'in_progress',
        position: 'z2',
      },
    });
    await setStatus(story.id, parked.key);

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'illegal_transition', toStatus: 'in_review' });
    expect(await statusOf(story.id)).toBe('parked');
    expect(sent).toHaveLength(0);
  });

  it('reports the rung it WANTED when no rung is legal from here', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done']);
    // A custom status with no outgoing edges — every rung is unreachable.
    const frozen = await adminDb.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'frozen',
        label: 'Frozen',
        category: 'todo',
        position: 'z1',
      },
    });
    await setStatus(story.id, frozen.key);

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    // Named, so the log says which move the workflow refused.
    expect(res).toMatchObject({ outcome: 'illegal_transition', toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('frozen');
    expect(sent).toHaveLength(0);
  });

  it('a parent whose only child is TRIAGED matches no rung either', async () => {
    // `no_rung` used to also cover "every child is still todo". The fourth rung
    // claims that case now (see its own block above), so the EMPTY aggregate is
    // the only shape left here — and a triaged child leaves the aggregate for the
    // same reason an archived one does (`findChildren` excludes both).
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo']);
    await setStatus(story.id, 'done');
    await adminDb.workItem.update({
      where: { id: children[0]!.id },
      data: { triagedAt: new Date() },
    });

    expect(await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId)).toEqual(
      {
        outcome: 'no_rung',
        parentId: story.id,
      },
    );
    expect(await statusOf(story.id)).toBe('done');
    expect(sent).toHaveLength(0);
  });
});

describe('the emitted event — what carries derivation to the next level', () => {
  it('emits work-item/transitioned for the PARENT, attributed to the workspace owner', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress']);

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe('work-item/transitioned');
    expect(sent[0]!.data).toMatchObject({
      workspaceId: fx.workspaceId,
      workItemId: story.id,
      actorId: fx.ownerId,
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
    });
    expect(sent[0]!.data['revisionId']).toEqual(expect.any(String));
  });

  it('records the move as an ordinary status revision on the parent', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress']);

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    const revs = await adminDb.workItemRevision.findMany({
      where: { workItemId: story.id },
      orderBy: { changedAt: 'desc' },
    });
    expect(revs[0]!.changeKind).toBe('updated');
    expect((revs[0]!.diff as Record<string, unknown>)['status']).toEqual({
      from: 'todo',
      to: 'in_progress',
    });
    // Attributed to the owner, so the activity feed reads as a real actor.
    expect(revs[0]!.changedById).toBe(fx.ownerId);
  });
});

describe('a RENAMED workflow still derives', () => {
  it('resolves each rung by CATEGORY when the canonical key is absent', async () => {
    const fx = await makeWorkItemFixture();
    // Rename `in_progress` → `doing`: the canonical key no longer exists, so the
    // resolver must fall back to the first status of the in_progress category.
    await adminDb.workflowStatus.updateMany({
      where: { projectId: fx.projectId, key: 'in_progress' },
      data: { key: 'doing' },
    });
    const { story, children } = await storyWithChildren(fx, ['doing']);

    // Sanity: the shared resolver reports the renamed key.
    expect(
      await workflowsService.resolveStatusKey(fx.projectId, fx.workspaceId, {
        key: 'in_progress',
        category: 'in_progress',
      }),
    ).toBe('doing');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'doing' });
    expect(await statusOf(story.id)).toBe('doing');
  });
});

describe('defensive error routing — the job must never fail behind a user transition', () => {
  // These arms guard a RACE: the target status is resolved (and its legality
  // checked) before `applyStatusTransition` runs, so a status deleted or a
  // permission revoked in that window surfaces from the write. They are
  // exercised by forcing the throw, because the point under test is the ROUTING
  // — a typed no-op instead of a propagated error — not the race itself.

  async function forceWriteError(err: Error) {
    const fx = await makeWorkItemFixture();
    const { children } = await storyWithChildren(fx, ['in_progress']);
    vi.spyOn(workItemsService, 'applyStatusTransition').mockRejectedValue(err);
    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    vi.restoreAllMocks();
    return res;
  }

  it('an UnknownStatusError from the write reads as no_matching_status', async () => {
    expect(await forceWriteError(new UnknownStatusError('ghost'))).toMatchObject({
      outcome: 'no_matching_status',
    });
  });

  it('a ProjectAccessDeniedError reads as access_denied', async () => {
    expect(await forceWriteError(new ProjectAccessDeniedError('p1', 'edit'))).toMatchObject({
      outcome: 'access_denied',
    });
  });

  it('a ProjectNotFoundError reads as access_denied too (no existence leak)', async () => {
    expect(await forceWriteError(new ProjectNotFoundError('p1'))).toMatchObject({
      outcome: 'access_denied',
    });
  });

  it('an IllegalTransitionError from the write is still absorbed', async () => {
    // Unreachable in practice — legality is pre-checked in the SAME transaction
    // — but absorbed rather than thrown, so a future refactor that drops the
    // pre-check degrades to a no-op instead of a red job.
    expect(await forceWriteError(new IllegalTransitionError('todo', 'done'))).toMatchObject({
      outcome: 'illegal_transition',
    });
  });

  it('an UNEXPECTED error still propagates — a real fault is not swallowed', async () => {
    await expect(forceWriteError(new Error('disk on fire'))).rejects.toThrow('disk on fire');
  });
});

describe('phase 1 binds the WORKSPACE, not the system flag (MOTIR-2880)', () => {
  // ⚠️ REPRODUCE-BEFORE-FIX, and the reproduction needs the non-bypass role.
  //
  // Phase 1 used to run under `withSystemContext`, which binds `app.system_admin`
  // and nothing else. `work_item` carries ONE permissive policy,
  // `work_item_active_workspace`, keyed purely on `app.workspace_id` — no arm reads
  // the system flag — so under `motir_app` the very first statement
  // (`findById(childId)`) returned NULL, `resolved` was null, and EVERY rollup
  // answered `{ outcome: 'no_parent' }`. RLS does not refuse a SELECT, it empties
  // it, so nothing raised and nothing was logged: a parent whose children all
  // finished simply never moved.
  //
  // ⚠️ DELIBERATELY NOT `describe.runIf(isAppRoleTestMode())`, the same choice
  // `tests/app-role-bound-context-reads.test.ts` documents: CI does not set the
  // flag, so a gated case would never run there. Under the bypass role these pass
  // trivially (RLS is inert); under `TEST_DB_APP_ROLE=1` the first one is red on
  // `main` and green here, and the second is the one that PINS the binding —
  // a system context would have returned the parent whatever workspace was named.

  // The preceding block's last case leaves a `vi.spyOn` throwing `disk on fire`
  // in place; these cases exercise the REAL write path.
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls the parent up under the non-bypass role — the read is workspace-bound', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done']);
    await setStatus(story.id, 'in_progress'); // the done rung's legal starting point

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    // On `main` under TEST_DB_APP_ROLE=1 this is `{ outcome: 'no_parent' }`.
    expect(res).toMatchObject({ outcome: 'rolled_up', parentId: story.id, toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('done');
  });

  it('a FOREIGN workspaceId resolves nothing — the binding is real, not decorative', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ identifier: 'OTHR' });
    const { story, children } = await storyWithChildren(fx, ['done']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, other.workspaceId);

    // Under the bypass role RLS is inert, so this case only BITES under
    // `TEST_DB_APP_ROLE=1` — where it is the difference between a bound read and a
    // system context that would have crossed the tenant boundary silently.
    if (isAppRoleTestMode()) {
      expect(res).toEqual({ outcome: 'no_parent' });
      expect(await statusOf(story.id)).not.toBe('done');
    }
  });
});
