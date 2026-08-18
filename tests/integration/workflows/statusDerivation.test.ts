import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService } from '@/lib/services/boardsService';
import { runCreateWorkItem } from '@/lib/mcp/tools/createWorkItem';
import { runMoveToParent } from '@/lib/mcp/tools/moveToParent';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { workflowsService } from '@/lib/services/workflowsService';
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
  // `workspaceId` is carried because the derivation services BIND it
  // (MOTIR-2880) — every `work-item/*` envelope has always had it, and the pump
  // reads it off the event rather than inventing one, so the drain drives the
  // production path. `toStatusKey` / `parentIds` are per-event (MOTIR-2892 added
  // the child-set envelope), hence optional.
  data: { workItemId: string; workspaceId: string; toStatusKey?: string; parentIds?: string[] };
}

const queue: Emitted[] = [];

/** Every event name `drain()` has played this test, in order — so a test can
 *  assert that a trigger produced NO derived transition, which an empty queue at
 *  the end cannot distinguish from one that produced several. */
const processed: string[] = [];

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
    processed.push(event.name);
    // Route by event NAME, exactly as `lib/jobs/registry.ts` does — derivation
    // has three consumers since MOTIR-2892, because a recompute is a function of
    // the child SET and `work-item/transitioned` fires on none of the edits that
    // change that set.
    //
    // ⚠️ The workspace comes off the EVENT in every branch, exactly as each job
    // step takes it from `payload.workspaceId` (MOTIR-2880). Both phases of the
    // rollup bind a workspace context, so a drain that invented one would not be
    // driving the production path.
    if (event.name === 'work-item/transitioned') {
      // The job's order, deliberately: rollup first — it is the direction that
      // can CREATE work for the other.
      await parentStatusRollupService.rollUpForChild(event.data.workItemId, event.data.workspaceId);
      await childStatusCascadeService.cascadeToChildren(
        event.data.workItemId,
        event.data.workspaceId,
      );
    } else if (event.name === 'work-item/created') {
      // No cascade: a create transitions nothing, so nothing ENTERED a
      // done-category status.
      await parentStatusRollupService.rollUpForChild(event.data.workItemId, event.data.workspaceId);
    } else if (event.name === 'work-item/child-set.changed') {
      for (const parentId of event.data.parentIds ?? []) {
        await parentStatusRollupService.recomputeParent(parentId, event.data.workspaceId);
      }
    }
    // Every other `work-item/*` event (embeddings, mentions) has no derivation
    // consumer and is simply drained.
  }
  return steps;
}

beforeEach(async () => {
  await truncateAuthTables();
  queue.length = 0;
  processed.length = 0;
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

  it('the recompute comes BACK: reopening a done child reopens the parent with it', async () => {
    // Replaced the forward-only assertion (MOTIR-2888 / MOTIR-2891). Driven
    // through the real event path, so this also proves the backward move EMITS —
    // without that emit the grandparent would never hear about it.
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['done', 'done']);
    await setStatus(story.id, 'done');

    await transitionAndDrain(fx, children[0]!.id, 'in_progress');

    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('the rollup toggle OFF suppresses it; ON it fires', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { autoRollupParentStatus: false },
    });
    const { story, children } = await tree(fx, ['todo']);

    await transitionAndDrain(fx, children[0]!.id, 'in_progress');
    expect(await statusOf(story.id)).toBe('todo');

    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { autoRollupParentStatus: true },
    });
    await transitionAndDrain(fx, children[0]!.id, 'in_review');
    // The in-review rung matches, but `todo → in_review` is not an edge — so the
    // forward WALK crosses `todo → in_progress → in_review`, both real edges of
    // this project's own graph, and the parent lands on the rung the recompute
    // actually named. (Before MOTIR-2901 it stopped one rung short, at
    // `in_progress`, and waited for an event that in this shape never comes.)
    expect(await statusOf(story.id)).toBe('in_review');
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
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((st) => st.key === k)!.id;
    const userEdge = await adminDb.workflowTransition.findFirst({
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

    const revs = await adminDb.workItemRevision.findMany({
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

  it('the cascade leaves an already-finished child untouched', async () => {
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
    await adminDb.project.update({
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

    await adminDb.project.update({
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

    const revsBefore = await adminDb.workItemRevision.count({ where: { workItemId: story.id } });

    // Redeliver the last event: same dispatch, same item, already-settled tree.
    await parentStatusRollupService.rollUpForChild(children[1]!.id, fx.workspaceId);
    await childStatusCascadeService.cascadeToChildren(children[1]!.id, fx.workspaceId);
    const extra = await drain();

    expect(extra).toBe(0); // nothing moved ⇒ nothing emitted
    expect(await statusOf(story.id)).toBe('done');
    expect(await adminDb.workItemRevision.count({ where: { workItemId: story.id } })).toBe(
      revsBefore,
    );
  });

  it('an ILLEGAL upward move is a logged no-op, not a thrown job', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['in_review', 'in_review']);

    // A custom status with NO outgoing transitions — the shape a team can really
    // create. Park the PARENT there (the children keep their normal path, so the
    // transitions driving this test stay legal). With every child done, the DONE
    // rung is the only match, and it is unreachable from here.
    const frozen = await adminDb.workflowStatus.create({
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

// ── The CHILD-SET triggers (Story MOTIR-2888 · Subtask MOTIR-2892, ADR §3a) ──
//
// Everything above rides `work-item/transitioned`. These drive the four edits
// that change a parent's child set WITHOUT transitioning anything, through their
// REAL ingress — the MCP `create_work_item` / `move_to_parent` tools and the
// archive / unarchive / delete service paths — never by calling a job handler.
// The pump routes each emitted event exactly as the registry does.

describe('the child-set triggers, end to end through their real ingress', () => {
  it('MCP create_work_item: a todo child under a DONE story brings the story back', async () => {
    // The story's own case (MOTIR-2888). Before this trigger existed, creating a
    // child emitted `work-item/created` and no derivation consumer read it, so
    // the board showed a finished story with untouched work inside it.
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['done']);
    await setStatus(story.id, 'done');

    const res = await runCreateWorkItem(
      {
        projectKey: fx.projectIdentifier,
        parentKey: (await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } }))
          .identifier,
        kind: 'subtask',
        title: 'New unstarted work',
      },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    await drain();

    expect(await statusOf(story.id)).toBe('todo');
    // And the cascade did NOT fire on the way: the child that brought the parent
    // back must not be force-closed by it.
    const created = await adminDb.workItem.findFirstOrThrow({
      where: { parentId: story.id, title: 'New unstarted work' },
    });
    expect(created.status).toBe('todo');
    expect(await statusOf(children[0]!.id)).toBe('done');
  });

  it('MCP create_work_item: a ROOT item with no parent derives nothing', async () => {
    const fx = await makeWorkItemFixture();

    const res = await runCreateWorkItem(
      { projectKey: fx.projectIdentifier, kind: 'story', title: 'Top level' },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();

    // The event fires on every creation in the workspace; with no parent the
    // consumer is a one-read no-op, so draining produces no derived transition
    // at all. (The queue also holds the unrelated embedding event every create
    // emits — the assertion is about what derivation DID, not the queue length.)
    await drain();
    expect(processed).toContain('work-item/created');
    expect(processed).not.toContain('work-item/transitioned');
  });

  it('a child created under a TODO parent changes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { story } = await tree(fx, ['todo']);

    await runCreateWorkItem(
      {
        projectKey: fx.projectIdentifier,
        parentKey: (await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } }))
          .identifier,
        kind: 'subtask',
        title: 'Another',
      },
      fx.ctx,
    );
    await drain();

    expect(await statusOf(story.id)).toBe('todo');
  });

  it('MCP move_to_parent: ONE move completes the old parent and reopens the new one', async () => {
    const fx = await makeWorkItemFixture();
    // A: one done child + the open one that is about to leave ⇒ A completes.
    const a = await createTestWorkItem(fx, { kind: 'story', title: 'A' });
    await setStatus(a.id, 'in_progress');
    const settled = await createTestWorkItem(fx, { kind: 'subtask', title: 'a1', parentId: a.id });
    await setStatus(settled.id, 'done');
    const mover = await createTestWorkItem(fx, { kind: 'subtask', title: 'a2', parentId: a.id });
    await setStatus(mover.id, 'todo');
    // B: finished ⇒ gaining an unstarted child brings it back.
    const b = await createTestWorkItem(fx, { kind: 'story', title: 'B' });
    await setStatus(b.id, 'done');
    const bChild = await createTestWorkItem(fx, { kind: 'subtask', title: 'b1', parentId: b.id });
    await setStatus(bChild.id, 'done');

    const rows = await adminDb.workItem.findMany({ where: { id: { in: [mover.id, b.id] } } });
    const identOf = (id: string) => rows.find((r) => r.id === id)!.identifier;
    const res = await runMoveToParent({ key: identOf(mover.id), parentKey: identOf(b.id) }, fx.ctx);
    expect(res.isError).toBeFalsy();
    await drain();

    expect(await statusOf(a.id)).toBe('done');
    expect(await statusOf(b.id)).toBe('todo');
    // The moved child itself is untouched by either recompute.
    expect(await statusOf(mover.id)).toBe('todo');
  });

  it('a pure REORDER emits nothing — no parent changed', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['todo', 'todo']);

    await workItemsService.moveWorkItem(children[1]!.id, { afterId: children[0]!.id }, fx.ctx);

    expect(queue).toHaveLength(0);
    expect(await statusOf(story.id)).toBe('todo');
  });

  it('archiving the only open child completes the parent; unarchiving brings it back', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['done', 'todo']);
    await setStatus(story.id, 'in_progress');

    await workItemsService.archiveWorkItem(children[1]!.id, fx.ctx);
    await drain();
    expect(await statusOf(story.id)).toBe('done');

    await workItemsService.unarchiveWorkItem(children[1]!.id, fx.ctx);
    await drain();
    expect(await statusOf(story.id)).toBe('todo');
    // The restored child keeps its own status — it was never transitioned.
    expect(await statusOf(children[1]!.id)).toBe('todo');
  });

  it('deleting the only open child completes the parent, and the GRANDPARENT follows', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await setStatus(epic.id, 'in_progress');
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'S', parentId: epic.id });
    await setStatus(story.id, 'in_progress');
    const done = await createTestWorkItem(fx, { kind: 'subtask', title: 's1', parentId: story.id });
    await setStatus(done.id, 'done');
    const open = await createTestWorkItem(fx, { kind: 'subtask', title: 's2', parentId: story.id });
    await setStatus(open.id, 'todo');

    await workItemsService.deleteWorkItem(open.id, fx.ctx);
    await drain();

    expect(await statusOf(story.id)).toBe('done');
    // No ancestor walk was added: the story's own transition re-emitted, and the
    // existing `work-item/transitioned` consumer carried it one level up.
    expect(await statusOf(epic.id)).toBe('done');
  });

  it('the rollup toggle OFF suppresses every child-set trigger too', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { autoRollupParentStatus: false },
    });
    const { story, children } = await tree(fx, ['done', 'todo']);
    await setStatus(story.id, 'done');

    await workItemsService.archiveWorkItem(children[1]!.id, fx.ctx);
    await drain();
    expect(await statusOf(story.id)).toBe('done');

    await runCreateWorkItem(
      {
        projectKey: fx.projectIdentifier,
        parentKey: (await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } }))
          .identifier,
        kind: 'subtask',
        title: 'Suppressed',
      },
      fx.ctx,
    );
    await drain();
    expect(await statusOf(story.id)).toBe('done');
  });
});

// ── The RECOMPUTE, assembled (Story MOTIR-2888 · Subtask MOTIR-2894) ─────────
//
// The blocks above prove each trigger fires. These prove the STORY: a parent
// that comes back, through the whole tree, with the termination argument that no
// longer leans on forward-only.

describe('the recompute, assembled — a parent that comes back', () => {
  it('the story CASE: a done story + a fresh todo child ⇒ the story AND its epic come back', async () => {
    // Case 1. The epic half is the one a single-level test cannot see, and it is
    // the whole point of "no ancestor walk": the story's own backward move
    // re-emits, and the ordinary transition consumer carries it up.
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'S', parentId: epic.id });
    const settled = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'settled',
      parentId: story.id,
    });
    await setStatus(settled.id, 'done');
    await setStatus(story.id, 'done');
    await setStatus(epic.id, 'done');

    await runCreateWorkItem(
      {
        projectKey: fx.projectIdentifier,
        parentKey: (await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } }))
          .identifier,
        kind: 'subtask',
        title: 'Fresh work',
      },
      fx.ctx,
    );
    await drain();

    expect(await statusOf(story.id)).toBe('todo');
    expect(await statusOf(epic.id)).toBe('todo');
    // The cascade did NOT fire on the way back — neither on the new child nor on
    // the one that was already finished.
    const fresh = await adminDb.workItem.findFirstOrThrow({
      where: { parentId: story.id, title: 'Fresh work' },
    });
    expect(fresh.status).toBe('todo');
    expect(await statusOf(settled.id)).toBe('done');
  });

  it('REOPEN, and back again: the parent follows its child in both directions', async () => {
    // Case 2. The round trip matters more than either leg: a recompute that only
    // came back would be a ratchet pointed the other way.
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['done', 'done']);
    await setStatus(story.id, 'done');

    await transitionAndDrain(fx, children[0]!.id, 'in_progress');
    expect(await statusOf(story.id)).toBe('in_progress');

    await transitionAndDrain(fx, children[0]!.id, 'in_review');
    expect(await statusOf(story.id)).toBe('in_review');

    await transitionAndDrain(fx, children[0]!.id, 'done');
    expect(await statusOf(story.id)).toBe('done');
  });

  it('the IN-REVIEW rung comes DOWN to in_progress when work is found during review', async () => {
    // Case 3, corrected against the rung table (ADR §3, and the story's own copy
    // of it). MOTIR-2894 predicted `todo` here; the rule gives `in_progress`,
    // and the rule is right: `in_review` sits in the IN_PROGRESS category, so a
    // sibling in review means work HAS started and rung 3 matches before rung 4
    // is ever reached. Rung 4's condition is "≥ 1 child in a todo-category
    // status AND NONE STARTED" — the next test is the case that satisfies it.
    // The card was amended on the record rather than the assertion bent to it.
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['done', 'in_progress']);
    await setStatus(story.id, 'in_progress');

    // A REAL move, not a re-set of the status the child already holds — a no-op
    // transition emits nothing, so nothing would derive.
    await transitionAndDrain(fx, children[1]!.id, 'in_review');
    expect(await statusOf(story.id)).toBe('in_review');

    // Work discovered during review: the parent comes BACK one rung, because it
    // is no longer true that every unfinished child is in review.
    const late = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'found in review',
      parentId: story.id,
    });
    // `createTestWorkItem` writes through the REPOSITORY, so the column default
    // (`open`) stands — and `open` is not a key in this project's workflow, so
    // the aggregate's JOIN drops the row entirely. Pin the status, as every
    // other test in this file does.
    await setStatus(late.id, 'todo');
    await parentStatusRollupService.rollUpForChild(late.id, fx.workspaceId);
    await drain();
    expect(await statusOf(story.id)).toBe('in_progress');

    // And back up: the new child reaches review too, so every unfinished child
    // is in review again.
    await transitionAndDrain(fx, late.id, 'in_progress');
    expect(await statusOf(story.id)).toBe('in_progress');
    await transitionAndDrain(fx, late.id, 'in_review');
    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('rung 4 needs NOTHING started — the review sibling is what kept it off', async () => {
    // The contrast that makes the rung boundary legible. Same shape as the test
    // above, with the in-review sibling FINISHED instead: now nothing is started
    // and the parent goes all the way back to To Do.
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['done', 'in_progress']);
    await setStatus(story.id, 'in_progress');

    await transitionAndDrain(fx, children[1]!.id, 'in_review');
    await transitionAndDrain(fx, children[1]!.id, 'done');
    expect(await statusOf(story.id)).toBe('done');

    const late = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'found after the fact',
      parentId: story.id,
    });
    // `createTestWorkItem` writes through the REPOSITORY, so the column default
    // (`open`) stands — and `open` is not a key in this project's workflow, so
    // the aggregate's JOIN drops the row entirely. Pin the status, as every
    // other test in this file does.
    await setStatus(late.id, 'todo');
    await parentStatusRollupService.rollUpForChild(late.id, fx.workspaceId);
    await drain();
    expect(await statusOf(story.id)).toBe('todo');

    await transitionAndDrain(fx, late.id, 'in_progress');
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('BACKWARD through an unhelpful workflow — no edge, and the grandparent still follows', async () => {
    // Case 4. `done → todo` is not a row in the default workflow (restricted
    // mode), and must not be added — those rows are user-draggable board edges.
    // So this lands only through the privileged system set, and it must still
    // write a revision and EMIT, or the epic never hears about it.
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'S', parentId: epic.id });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'child',
      parentId: story.id,
    });
    await setStatus(child.id, 'todo');
    await setStatus(story.id, 'done');
    await setStatus(epic.id, 'done');

    expect(await workflowsService.canTransition(fx.projectId, 'done', 'todo', fx.workspaceId)).toBe(
      false,
    );

    await parentStatusRollupService.rollUpForChild(child.id, fx.workspaceId);
    await drain();

    expect(await statusOf(story.id)).toBe('todo');
    expect(await statusOf(epic.id)).toBe('todo');
    const revs = await adminDb.workItemRevision.findMany({
      where: { workItemId: story.id },
      orderBy: { changedAt: 'desc' },
    });
    expect((revs[0]!.diff as Record<string, unknown>)['status']).toEqual({
      from: 'done',
      to: 'todo',
    });
  });

  it('NO LOOP: a USER setting a parent done cascades, recomputes to done, and stops', async () => {
    // Case 8. The termination argument's cross-direction half, driven from the
    // direction that actually engages both: the parent ENTERS done, so the
    // cascade fires; each completed child re-emits; each re-emission recomputes
    // the parent, whose children are now all done — rung 1 returns `done`, the
    // parent is already there, and that no-op emits nothing. A bounded step
    // count is the assertion, not just the final state: a converging loop and a
    // runaway one reach the same statuses.
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['todo', 'todo', 'in_progress']);
    await setStatus(story.id, 'in_progress');

    const steps = await transitionAndDrain(fx, story.id, 'done');

    expect(await statusOf(story.id)).toBe('done');
    for (const c of children) expect(await statusOf(c.id)).toBe('done');
    expect(steps).toBeLessThan(MAX_STEPS);
    expect(queue).toHaveLength(0);
    // And the parent moved exactly ONCE — the recompute that ran after each
    // child's re-emission found it already `done` and emitted nothing.
    const storyStatusRevs = (
      await adminDb.workItemRevision.findMany({ where: { workItemId: story.id } })
    ).filter((r) => (r.diff as Record<string, unknown>)['status']);
    expect(storyStatusRevs).toHaveLength(1);
  });
});

describe('the child finished FASTER than derivation ran (MOTIR-2901)', () => {
  // Every other suite in this file — and every one in `parentStatusRollup.test.ts`
  // — drains between transitions, so each derivation pass reads an INTERMEDIATE
  // aggregate and walks one legal edge at a time. That is the shape that hides
  // this defect. Here the transitions all COMMIT FIRST and derivation runs
  // afterwards, which is what a user dragging a card twice produces, and what the
  // agent loop produces every time (dispatch → In Progress, PR open → In Review,
  // merge → Done, often seconds apart).
  //
  // The aggregate every pass then reads is the FINAL one, so the only matching
  // rung is `done`, there is no lower rung to fall to, and `todo → done` is not
  // an edge in the default workflow and must not become one. Before MOTIR-2901
  // this stranded the parent at `todo` permanently — three `illegal_transition`
  // outcomes and no further event, because the child set never changes again.

  /** Commit N transitions on one child with NO derivation in between. */
  async function raceAhead(fx: WorkItemFixture, id: string, keys: string[]): Promise<void> {
    for (const key of keys) await workItemsService.updateStatus(id, key, fx.ctx);
    // The point of the whole suite: nothing has derived yet.
    expect(queue).toHaveLength(keys.length);
  }

  it('todo → in_progress → in_review → done, all committed first ⇒ the parent is done', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['todo']);

    await raceAhead(fx, children[0]!.id, ['in_progress', 'in_review', 'done']);
    const steps = await drain();

    expect(await statusOf(story.id)).toBe('done');
    expect(steps).toBeLessThan(MAX_STEPS);
    expect(queue).toHaveLength(0);

    // The walk wrote one revision per HOP — the honest record of the edges it
    // crossed, each a status the item genuinely held — and took the SHORTEST
    // path, trying the highest stone first at every step: `todo → in_progress`
    // (in_review is illegal from todo), then straight over MOTIR-1625's
    // `in_progress → done`. It never stands on In Review here.
    const storyStatusRevs = (
      await adminDb.workItemRevision.findMany({
        where: { workItemId: story.id },
        orderBy: { changedAt: 'asc' },
      })
    )
      .map((r) => (r.diff as Record<string, { from: string; to: string }>)['status'])
      .filter(Boolean);
    expect(storyStatusRevs).toEqual([
      { from: 'todo', to: 'in_progress' },
      { from: 'in_progress', to: 'done' },
    ]);
    // ...and emitted ONCE, for the NET move. An event is a notification: a
    // watcher must not be told twice about one derivation, and the epic above
    // must not recompute twice either. Three child transitions + one parent = four.
    expect(processed.filter((n) => n === 'work-item/transitioned')).toHaveLength(4);
  });

  it('the two-step shape todo → in_review lands on the top rung, not one short', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['todo']);

    await raceAhead(fx, children[0]!.id, ['in_progress', 'in_review']);
    await drain();

    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('the two-step shape todo → done lands on the top rung too', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['in_progress']);

    await raceAhead(fx, children[0]!.id, ['in_review', 'done']);
    await drain();

    expect(await statusOf(story.id)).toBe('done');
  });

  it('a parent TWO LEVELS up follows, through the same re-emission', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await setStatus(epic.id, 'todo');
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'S', parentId: epic.id });
    await setStatus(story.id, 'todo');
    const child = await createTestWorkItem(fx, { kind: 'subtask', title: 'c', parentId: story.id });
    await setStatus(child.id, 'todo');

    await raceAhead(fx, child.id, ['in_progress', 'in_review', 'done']);
    const steps = await drain();

    expect(await statusOf(story.id)).toBe('done');
    expect(await statusOf(epic.id)).toBe('done');
    expect(steps).toBeLessThan(MAX_STEPS);
  });

  it('and NO new workflow_transition row was needed to do any of it', async () => {
    // AC 3, asserted rather than asserted-about: transition rows are the board's
    // user-draggable edges, so a fix that reached `done` by ADDING `todo → done`
    // would let anyone skip the entire workflow by hand. The parent reaches done
    // over the edges the project already had.
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['todo']);
    const edgesBefore = await adminDb.workflowTransition.count({
      where: { projectId: fx.projectId },
    });

    await raceAhead(fx, children[0]!.id, ['in_progress', 'in_review', 'done']);
    await drain();

    expect(await statusOf(story.id)).toBe('done');
    expect(await adminDb.workflowTransition.count({ where: { projectId: fx.projectId } })).toBe(
      edgesBefore,
    );
    expect(await workflowsService.canTransition(fx.projectId, 'todo', 'done', fx.workspaceId)).toBe(
      false,
    );
    expect(
      await workflowsService.canTransition(fx.projectId, 'todo', 'in_review', fx.workspaceId),
    ).toBe(false);
  });

  it('a graph with no PATH still strands nothing — it is a logged no-op', async () => {
    // The conservative half of "the derivation respects your workflow". A walk is
    // still only ever real edges: cut every ladder edge out of `todo` and the
    // parent does not move at all, rather than acquiring a system bypass.
    const fx = await makeWorkItemFixture();
    const { story, children } = await tree(fx, ['todo']);
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const todoId = statuses.find((s) => s.key === 'todo')!.id;

    await workItemsService.updateStatus(children[0]!.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(children[0]!.id, 'in_review', fx.ctx);
    await workItemsService.updateStatus(children[0]!.id, 'done', fx.ctx);
    await adminDb.workflowTransition.deleteMany({
      where: { projectId: fx.projectId, fromStatusId: todoId },
    });

    const steps = await drain();

    expect(await statusOf(story.id)).toBe('todo');
    expect(steps).toBeLessThan(MAX_STEPS);
    expect(queue).toHaveLength(0);
  });
});

// ── The USER's write vs a derived backward set (Bug MOTIR-2965, ADR §5) ──
//
// MOTIR-2957 fixed the ordering hole on the CASCADE's side; this is the same
// hole on the ROLLUP's. A rung-4 backward set needs no legal edge, so it can
// overwrite a status a person set — and the person then meets a 422 on their
// NEXT click, for a reason that lives in the previous one.
//
// The interleaving is driven deterministically: the pump holds the create's
// event, so `drain()` plays the recompute at the exact instant the fixture
// names — BETWEEN the user's two hops.
describe("a user's own write vs a derived backward set", () => {
  it('the recompute does NOT undo a status the user set AFTER the child was created', async () => {
    // The card's fixture, step by step. The measured window is ~350 ms; here it
    // is exact, because the queue is only played when this test says so.
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Plan me' });
    await setStatus(story.id, 'todo');
    const identifier = (await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } }))
      .identifier;

    // 1. The user adds a subtask. `work-item/created` is QUEUED — the rung-4
    //    recompute has not run yet.
    const res = await runCreateWorkItem(
      { projectKey: fx.projectIdentifier, parentKey: identifier, kind: 'subtask', title: 'First' },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();

    // 2. Within the job's latency the user starts the story. Legal, accepted.
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
    expect(await statusOf(story.id)).toBe('in_progress');

    // 3. The queued recompute lands NOW — between the two clicks. Its rung-4
    //    reading is accurate (one child, todo, nothing started) and its claim is
    //    nonetheless STALE about the row: the status it is about to overwrite is
    //    newer than the child-set edit that woke it.
    await drain();

    // 4. The user clicks Done. This is the assertion the bug is about: before
    //    the fix the story sat at `todo` here, and `todo → done` is not an edge,
    //    so the second click came back 422.
    expect(await statusOf(story.id)).toBe('in_progress');
    await workItemsService.updateStatus(story.id, 'done', fx.ctx);
    expect(await statusOf(story.id)).toBe('done');
  });
});
