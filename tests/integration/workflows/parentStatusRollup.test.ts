import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
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

// `parentStatusRollupService.rollUpForChild` — the UPWARD half of bidirectional
// status derivation (Story MOTIR-1615 · Subtask MOTIR-1620). Real Postgres.
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
});

async function setStatus(id: string, status: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}

async function statusOf(id: string): Promise<string> {
  return (await db.workItem.findUniqueOrThrow({ where: { id } })).status;
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

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);

    expect(res).toEqual({ outcome: 'rolled_up', parentId: story.id, toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('in-review rung: the LAST open child reaches review ⇒ parent in_review', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'done']);
    await setStatus(story.id, 'in_progress'); // where the previous rung left it

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);

    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'in_review' });
    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('in-review rung does NOT fire while a child is still open', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'todo']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);

    // The in-progress rung is the only match, and the parent is already there.
    expect(res).toMatchObject({ outcome: 'already_there' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('done rung: every child done ⇒ parent done, straight from in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);

    // This is the move MOTIR-1625's in_progress → done edge exists for.
    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('done');
  });

  it('a CANCELLED child counts as done (category, not key)', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'cancelled']);
    await setStatus(story.id, 'in_progress');

    await parentStatusRollupService.rollUpForChild(children[0]!.id);
    expect(await statusOf(story.id)).toBe('done');
  });

  it('the done rung beats the in-review rung when both could match', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_review');

    await parentStatusRollupService.rollUpForChild(children[0]!.id);
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

    const res = await parentStatusRollupService.rollUpForChild(story.id);
    expect(res).toMatchObject({ outcome: 'rolled_up', parentId: epic.id });
    expect(await statusOf(epic.id)).toBe('in_progress');
  });
});

describe('forward-only', () => {
  it('a child reopening done → in_progress does NOT roll the parent back', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress', 'done']);
    await setStatus(story.id, 'done'); // the parent had already completed

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);

    expect(res).toMatchObject({ outcome: 'not_forward', toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('done');
    expect(sent).toHaveLength(0);
  });

  it('an in_review parent is not dragged back to in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress', 'in_review']);
    await setStatus(story.id, 'in_review');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);
    expect(res).toMatchObject({ outcome: 'not_forward' });
    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('already in the target status is a no-op that emits nothing (recursion terminates)', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);
    expect(res).toMatchObject({ outcome: 'already_there' });
    expect(sent).toHaveLength(0);
  });
});

describe('gates and no-ops', () => {
  it('a top-level item with no parent is a clean no-op', async () => {
    const fx = await makeWorkItemFixture();
    const orphan = await createTestWorkItem(fx, { kind: 'story', title: 'Top level' });
    await setStatus(orphan.id, 'in_progress');

    expect(await parentStatusRollupService.rollUpForChild(orphan.id)).toEqual({
      outcome: 'no_parent',
    });
    expect(sent).toHaveLength(0);
  });

  it('the toggle OFF suppresses the rollup entirely', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');
    await db.project.update({
      where: { id: fx.projectId },
      data: { autoRollupParentStatus: false },
    });

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);
    expect(res).toEqual({ outcome: 'toggle_off', parentId: story.id });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('the DOWNWARD toggle does not suppress the upward rollup', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');
    await db.project.update({
      where: { id: fx.projectId },
      data: { autoCompleteChildrenOnParentDone: false },
    });

    expect(await parentStatusRollupService.rollUpForChild(children[0]!.id)).toMatchObject({
      outcome: 'rolled_up',
    });
  });

  it('an ILLEGAL move is a logged no-op, never a throw', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');
    // Remove the very edge MOTIR-1625 added, leaving the done rung unreachable
    // from in_progress — the shape a team with a custom graph can produce.
    const statuses = await db.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((s) => s.key === k)!.id;
    await db.workflowTransition.deleteMany({
      where: {
        projectId: fx.projectId,
        fromStatusId: idOf('in_progress'),
        toStatusId: idOf('done'),
      },
    });

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);

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

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);

    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('reports the rung it WANTED when no rung is legal from here', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done']);
    // A custom status with no outgoing edges — every rung is unreachable.
    const frozen = await db.workflowStatus.create({
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

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);

    // Named, so the log says which move the workflow refused.
    expect(res).toMatchObject({ outcome: 'illegal_transition', toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('frozen');
    expect(sent).toHaveLength(0);
  });

  it('a parent whose children are all still todo matches no rung', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo', 'blocked']);

    expect(await parentStatusRollupService.rollUpForChild(children[0]!.id)).toEqual({
      outcome: 'no_rung',
      parentId: story.id,
    });
  });
});

describe('the emitted event — what carries derivation to the next level', () => {
  it('emits work-item/transitioned for the PARENT, attributed to the workspace owner', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress']);

    await parentStatusRollupService.rollUpForChild(children[0]!.id);

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

    await parentStatusRollupService.rollUpForChild(children[0]!.id);

    const revs = await db.workItemRevision.findMany({
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
    await db.workflowStatus.updateMany({
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

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);
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
    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id);
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
