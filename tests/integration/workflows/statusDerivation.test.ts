import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService } from '@/lib/services/boardsService';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { childStatusCascadeService } from '@/lib/services/childStatusCascadeService';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-1615 · Subtask MOTIR-1623 — the STORY-LEVEL integration seam for
// bidirectional status derivation, against real Postgres.
//
// The per-subtask suites each drive ONE service directly. What only this file
// reaches is the ASSEMBLED loop: a real `updateStatus` emits
// `work-item/transitioned`, the job consumes it and dispatches both directions,
// each derived transition emits again, and the whole thing has to terminate.
//
// ── The event pump ──
// Inngest's transport is the one thing substituted. `sendEvent` is stubbed to
// push into a queue, and `drain()` plays the queue through the SAME dispatch the
// job performs (rollup, then cascade), so every service, transition, lock,
// revision and emit below is the real one. The pump carries a hard step CAP: a
// derivation that failed to terminate would otherwise hang the suite, and here
// it FAILS instead — which is what makes "it terminates" a real assertion rather
// than an absence of evidence.

interface Emitted {
  name: string;
  data: { workItemId: string; toStatusKey: string };
}

const queue: Emitted[] = [];

vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    queue.push({ name, data: data as Emitted['data'] });
  },
}));

/** How many derivation steps a healthy chain can possibly need here. The deepest
 *  tree in this file is epic → story → task → subtask (4 levels), each level
 *  emitting at most once per direction; 40 is generous by an order of magnitude
 *  and still catches a runaway. */
const MAX_STEPS = 40;

/**
 * Play the emitted events through the job's dispatch until the queue drains.
 * Returns the number of derivation steps taken — the termination evidence.
 */
async function drain(): Promise<number> {
  let steps = 0;
  while (queue.length > 0) {
    steps += 1;
    if (steps > MAX_STEPS) {
      throw new Error(
        `status derivation did not terminate: still ${queue.length} event(s) queued after ${MAX_STEPS} steps`,
      );
    }
    const event = queue.shift()!;
    expect(event.name).toBe('work-item/transitioned');
    // The job's order, deliberately: rollup first — it is the direction that can
    // CREATE work for the other.
    await parentStatusRollupService.rollUpForChild(event.data.workItemId);
    await childStatusCascadeService.cascadeToChildren(event.data.workItemId);
  }
  return steps;
}

beforeEach(async () => {
  await truncateAuthTables();
  queue.length = 0;
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

/** A story with N subtasks, statuses pinned explicitly (the fixture writes
 *  through the repository, which skips the service's initial-status lookup). */
async function tree(fx: WorkItemFixture, childStatuses: string[]) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
  await setStatus(story.id, 'todo');
  const children = [];
  for (const [i, s] of childStatuses.entries()) {
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

/** Drive a transition the way every ingress does — through the shared authority
 *  — then play the resulting derivation to completion. */
async function transitionAndDrain(fx: WorkItemFixture, id: string, to: string): Promise<number> {
  await workItemsService.updateStatus(id, to, fx.ctx);
  return drain();
}

describe('the upward ladder, end to end through the real transition path', () => {
  it('the first child to start moves the parent to in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['todo', 'todo']);

    await transitionAndDrain(fx, children[0]!.id, 'in_progress');

    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('the last open child reaching review moves the parent to the in_review KEY', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['todo', 'todo']);

    await transitionAndDrain(fx, children[0]!.id, 'in_progress');
    await transitionAndDrain(fx, children[1]!.id, 'in_progress');
    await transitionAndDrain(fx, children[0]!.id, 'in_review');
    // One child is still in progress — the review rung must NOT fire yet.
    expect(await statusOf(story.id)).toBe('in_progress');

    await transitionAndDrain(fx, children[1]!.id, 'in_review');

    // The specific KEY, not merely the in_progress CATEGORY it shares.
    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('all children done moves the parent to done', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['in_review', 'in_review']);
    await setStatus(story.id, 'in_progress');

    await transitionAndDrain(fx, children[0]!.id, 'done');
    // One child is still in review, so the DONE rung does not match — but the
    // IN-REVIEW rung now does (every child is in review or done), so the parent
    // advances there rather than standing still.
    expect(await statusOf(story.id)).toBe('in_review');

    await transitionAndDrain(fx, children[1]!.id, 'done');

    expect(await statusOf(story.id)).toBe('done');
  });

  it('forward-only: reopening a done child does not roll the parent back', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['done', 'done']);
    await setStatus(story.id, 'done');

    await transitionAndDrain(fx, children[0]!.id, 'in_progress');

    expect(await statusOf(story.id)).toBe('done');
  });

  it('the rollup toggle OFF suppresses it; ON it fires', async () => {
    const fx = await makeWorkItemFixture();
    await db.project.update({
      where: { id: fx.projectId },
      data: { autoRollupParentStatus: false },
    });
    const { story, children } = await tree(fx, ['todo']);

    await transitionAndDrain(fx, children[0]!.id, 'in_progress');
    expect(await statusOf(story.id)).toBe('todo');

    await db.project.update({
      where: { id: fx.projectId },
      data: { autoRollupParentStatus: true },
    });
    await transitionAndDrain(fx, children[0]!.id, 'in_review');
    // The in-review rung matches, but `todo → in_review` is not an edge, so the
    // rung FALLBACK lands the parent on in_progress — as far forward as this
    // workflow allows, rather than stranding it in todo.
    expect(await statusOf(story.id)).toBe('in_progress');
  });
});

describe('the downward cascade, end to end through the real transition path', () => {
  it('completes a TODO child — the move no legal user transition allows', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    await setStatus(story.id, 'in_review');
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Never started',
      parentId: story.id,
    });
    await setStatus(child.id, 'todo');

    await transitionAndDrain(fx, story.id, 'done');

    expect(await statusOf(child.id)).toBe('done');
    // The system bypass did NOT come from a new user-draggable edge — asserted
    // on the graph itself, so a future "fix" that adds one fails here.
    const statuses = await db.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((st) => st.key === k)!.id;
    const userEdge = await db.workflowTransition.findFirst({
      where: {
        projectId: fx.projectId,
        fromStatusId: idOf('todo'),
        toStatusId: idOf('done'),
      },
    });
    expect(userEdge).toBeNull();
  });

  it('records a revision for each cascaded child, attributed to the workspace owner', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    await setStatus(story.id, 'in_review');
    const blocked = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Blocked',
      parentId: story.id,
    });
    await setStatus(blocked.id, 'blocked');

    await transitionAndDrain(fx, story.id, 'done');

    const revs = await db.workItemRevision.findMany({
      where: { workItemId: blocked.id },
      orderBy: { changedAt: 'desc' },
    });
    expect(revs[0]!.changeKind).toBe('updated');
    expect((revs[0]!.diff as Record<string, unknown>)['status']).toEqual({
      from: 'blocked',
      to: 'done',
    });
    expect(revs[0]!.changedById).toBe(fx.ownerId);
  });

  it('a NON-done parent transition triggers no cascade', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['todo']);

    await transitionAndDrain(fx, story.id, 'in_progress');

    expect(await statusOf(children[0]!.id)).toBe('todo');
  });

  it('forward-only: an already-done child is untouched', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    await setStatus(story.id, 'in_review');
    const cancelled = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Cancelled',
      parentId: story.id,
    });
    await setStatus(cancelled.id, 'cancelled');

    await transitionAndDrain(fx, story.id, 'done');

    // A cancelled child keeps the terminal status its team chose.
    expect(await statusOf(cancelled.id)).toBe('cancelled');
  });

  it('the cascade toggle OFF suppresses it; ON it fires', async () => {
    const fx = await makeWorkItemFixture();
    await db.project.update({
      where: { id: fx.projectId },
      data: { autoCompleteChildrenOnParentDone: false },
    });
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    await setStatus(story.id, 'in_review');
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Child',
      parentId: story.id,
    });
    await setStatus(child.id, 'todo');

    await transitionAndDrain(fx, story.id, 'done');
    expect(await statusOf(child.id)).toBe('todo');

    await db.project.update({
      where: { id: fx.projectId },
      data: { autoCompleteChildrenOnParentDone: true },
    });
    // Reopen and re-complete the parent to fire the trigger again.
    await transitionAndDrain(fx, story.id, 'in_progress');
    await transitionAndDrain(fx, story.id, 'done');
    expect(await statusOf(child.id)).toBe('done');
  });
});

describe('recursion, termination, and up↔down non-interference', () => {
  it('rolls UP a whole subtask → task → story → epic chain, and terminates', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await setStatus(epic.id, 'todo');
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Story',
      parentId: epic.id,
    });
    await setStatus(story.id, 'todo');
    const task = await createTestWorkItem(fx, { kind: 'task', title: 'Task', parentId: story.id });
    await setStatus(task.id, 'todo');
    const leaf = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Leaf',
      parentId: task.id,
    });
    await setStatus(leaf.id, 'todo');

    const steps = await transitionAndDrain(fx, leaf.id, 'in_progress');

    // Three levels above the leaf all followed, from ONE user transition.
    expect(await statusOf(task.id)).toBe('in_progress');
    expect(await statusOf(story.id)).toBe('in_progress');
    expect(await statusOf(epic.id)).toBe('in_progress');
    expect(steps).toBeLessThan(MAX_STEPS);
    expect(queue).toHaveLength(0);
  });

  it('cascades DOWN a whole epic → story → subtask chain, and terminates', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await setStatus(epic.id, 'in_review');
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Story',
      parentId: epic.id,
    });
    await setStatus(story.id, 'todo');
    const leaf = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Leaf',
      parentId: story.id,
    });
    await setStatus(leaf.id, 'todo');

    const steps = await transitionAndDrain(fx, epic.id, 'done');

    expect(await statusOf(story.id)).toBe('done');
    expect(await statusOf(leaf.id)).toBe('done');
    expect(steps).toBeLessThan(MAX_STEPS);
    expect(queue).toHaveLength(0);
  });

  it('up↔down cannot loop: a parent completed by rollup does not re-cascade forever', async () => {
    // Both directions engaged at once — the shape most likely to loop if the
    // non-interference argument were wrong.
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await setStatus(epic.id, 'in_progress');
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Story',
      parentId: epic.id,
    });
    await setStatus(story.id, 'in_progress');
    const a = await createTestWorkItem(fx, { kind: 'subtask', title: 'A', parentId: story.id });
    const b = await createTestWorkItem(fx, { kind: 'subtask', title: 'B', parentId: story.id });
    await setStatus(a.id, 'in_review');
    await setStatus(b.id, 'todo');

    // A completes → the story cannot roll up yet (B open). Then B completes →
    // the story rolls to done → which cascades over children that are ALREADY
    // done (a no-op) → and rolls the epic up.
    await transitionAndDrain(fx, a.id, 'done');
    const steps = await transitionAndDrain(fx, b.id, 'in_progress');
    expect(steps).toBeLessThan(MAX_STEPS);

    await transitionAndDrain(fx, b.id, 'in_review');
    const finalSteps = await transitionAndDrain(fx, b.id, 'done');

    expect(await statusOf(story.id)).toBe('done');
    expect(await statusOf(epic.id)).toBe('done');
    expect(finalSteps).toBeLessThan(MAX_STEPS);
    expect(queue).toHaveLength(0);
  });

  it('is IDEMPOTENT under redelivery — replaying an event changes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['in_review', 'in_review']);
    await setStatus(story.id, 'in_progress');

    await transitionAndDrain(fx, children[0]!.id, 'done');
    await transitionAndDrain(fx, children[1]!.id, 'done');
    expect(await statusOf(story.id)).toBe('done');

    const revsBefore = await db.workItemRevision.count({ where: { workItemId: story.id } });

    // Redeliver the last event: same dispatch, same item, already-settled tree.
    await parentStatusRollupService.rollUpForChild(children[1]!.id);
    await childStatusCascadeService.cascadeToChildren(children[1]!.id);
    const extra = await drain();

    expect(extra).toBe(0); // nothing moved ⇒ nothing emitted
    expect(await statusOf(story.id)).toBe('done');
    expect(await db.workItemRevision.count({ where: { workItemId: story.id } })).toBe(revsBefore);
  });

  it('an ILLEGAL upward move is a logged no-op, not a thrown job', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['in_review', 'in_review']);

    // A custom status with NO outgoing transitions — the shape a team can really
    // create. Park the PARENT there (the children keep their normal path, so the
    // transitions driving this test stay legal). With every child done, the DONE
    // rung is the only match, and it is unreachable from here.
    const frozen = await db.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'frozen',
        label: 'Frozen',
        category: 'todo',
        position: 'z0',
      },
    });
    await setStatus(story.id, frozen.key);

    await transitionAndDrain(fx, children[0]!.id, 'done');
    // Must not throw — a derivation the workflow cannot make is a logged no-op,
    // never a failed job behind a status change the user already made.
    await expect(transitionAndDrain(fx, children[1]!.id, 'done')).resolves.toBeGreaterThanOrEqual(
      0,
    );

    // Untouched: the rollup never forces a move the team's graph forbids. (That
    // asymmetry is deliberate — only the downward cascade holds system authority.)
    expect(await statusOf(story.id)).toBe('frozen');
  });
});

describe('ingress coverage — derivation rides the event, not one entry point', () => {
  it('fires for a BOARD move, the same as for a service/MCP transition', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['todo']);

    // The board is the other write path into `applyStatusTransition` — it calls
    // it inside its OWN transaction, so this proves derivation is not welded to
    // `updateStatus`.
    const projection = await boardsService.getBoard(fx.projectId, fx.ctx);
    const target = projection.columns.find((c) => c.statusKeys.includes('in_progress'))!;

    await boardsService.moveCard(
      projection.boardId,
      children[0]!.id,
      { toColumnId: target.id },
      fx.ctx,
    );
    await drain();

    expect(await statusOf(children[0]!.id)).toBe('in_progress');
    expect(await statusOf(story.id)).toBe('in_progress');
  });
});
