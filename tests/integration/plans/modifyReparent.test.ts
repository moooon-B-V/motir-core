import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { InvalidProposalError, PlanGrammarError, PlanRefGraphError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-3859 — a `modify` proposal RE-PARENTS its target, against real Postgres
// (no mocks, per CLAUDE.md).
//
// `agent-authored-plans.md` AMENDMENT 11. D3 drew the deepen line as *"a deepen
// may change what a card SAYS and who ACTS on it; it may not change where the
// card SITS or SHIPS"* — and the `modify` patch was then given SHIPS twice
// (MOTIR-1884 / MOTIR-1912) and SITS never. These are the checks the missing
// half owes.
//
// ⚠️ WHY SO MANY OF THESE ASSERT AT THE **APPEND**. A re-parent's five guards
// are all questions about a LIVE row that must exist already, so nothing a later
// call can do turns an illegal move into a legal one — which is
// `assertTempRefsResolvable`'s own argument (MOTIR-3539) for refusing where the
// ref is written. Left to approve, a cycle or an over-deep move arrives as a raw
// SQLSTATE from the `work_item` triggers, inside a `PlanPersistenceError`, at the
// button, where the plan is immutable and the only repair is a whole new plan.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedItem(
  fx: WorkItemFixture,
  title: string,
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask' = 'task',
  parentId?: string,
): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return dto.id;
}

async function markDone(fx: WorkItemFixture, id: string): Promise<void> {
  await workItemsService.updateStatus(id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(id, 'in_review', fx.ctx);
  await workItemsService.updateStatus(id, 'done', fx.ctx);
}

async function openPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Proposed' }, fx.ctx);
  return plan.id;
}

/** Run `fn`, return what it threw (and fail if it threw nothing). */
async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  let thrown: Error | undefined;
  try {
    await fn();
  } catch (err) {
    thrown = err as Error;
  }
  expect(thrown, 'the call must be rejected').toBeInstanceOf(Error);
  return thrown!;
}

async function parentIdOf(id: string): Promise<string | null> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).parentId;
}

async function proposalCount(planId: string): Promise<number> {
  return adminDb.planItem.count({ where: { planId } });
}

/** Append ONE `modify` carrying a re-parent, and return the rejection. */
function appendReparent(
  fx: WorkItemFixture,
  planId: string,
  workItemId: string,
  parentRef: string | null,
): Promise<unknown> {
  return plansService.addProposals(
    planId,
    [{ op: 'modify', workItemId, patch: { parentRef } }],
    fx.ctx,
  );
}

describe('a `modify` RE-PARENTS its target on approve', () => {
  it('moves the card, and the move is what `parentId` reads back as', async () => {
    const fx = await makeWorkItemFixture();
    const from = await seedItem(fx, 'The story it leaves', 'story');
    const to = await seedItem(fx, 'The story it joins', 'story');
    const card = await seedItem(fx, 'The card', 'subtask', from);
    expect(await parentIdOf(card)).toBe(from);

    const planId = await openPlan(fx);
    await appendReparent(fx, planId, card, to);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    expect(await parentIdOf(card)).toBe(to);
  });

  it('records a `parentId` diff cell on the modify revision — ONE revision, as every other key does', async () => {
    const fx = await makeWorkItemFixture();
    const from = await seedItem(fx, 'From', 'story');
    const to = await seedItem(fx, 'To', 'story');
    const card = await seedItem(fx, 'The card', 'subtask', from);

    const planId = await openPlan(fx);
    // A re-parent AND a re-title, so the "one revision for the whole modify"
    // guarantee is asserted rather than assumed: the parent must ride the SAME
    // row as the title, not a second one.
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: card, patch: { parentRef: to, title: 'Renamed' } }],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: card, changeKind: 'updated' },
      orderBy: { changedAt: 'asc' },
    });
    expect(revisions).toHaveLength(1);
    const diff = revisions[0]!.diff as Record<string, unknown>;
    expect(diff.parentId).toEqual({ from, to });
    expect(diff.title).toEqual({ from: 'The card', to: 'Renamed' });
  });

  it('an explicit `null` moves the card to the PROJECT ROOT (and is not the same as omitting the key)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedItem(fx, 'The epic', 'epic');
    // A `task` may sit at the root; a `subtask` may not — which is the arm the
    // kind case below pins.
    const card = await seedItem(fx, 'The card', 'task', epic);

    const planId = await openPlan(fx);
    await appendReparent(fx, planId, card, null);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    expect(await parentIdOf(card)).toBeNull();
  });

  it('leaves the parent ALONE when the patch omits the key — absent is not `null`', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seedItem(fx, 'The story', 'story');
    const card = await seedItem(fx, 'The card', 'subtask', story);

    const planId = await openPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: card, patch: { title: 'Renamed only' } }],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    expect(await parentIdOf(card)).toBe(story);
  });
});

describe('the re-parent is refused AT THE APPEND — one assertion per rule', () => {
  it('KIND-ILLEGAL: a subtask may not be parented to another subtask', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seedItem(fx, 'The story', 'story');
    const leaf = await seedItem(fx, 'A leaf', 'subtask', story);
    const card = await seedItem(fx, 'The card', 'subtask', story);

    const planId = await openPlan(fx);
    const err = await rejection(() => appendReparent(fx, planId, card, leaf));

    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('illegal_parent');
    expect(await proposalCount(planId)).toBe(0);
    expect(await parentIdOf(card)).toBe(story);
  });

  it('ANOTHER PROJECT: parentage is same-project by invariant, and the refusal says so', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seedItem(fx, 'The story', 'story');
    const card = await seedItem(fx, 'The card', 'subtask', story);
    // A second project in the SAME workspace — visible to the read only because
    // the append suspends the project narrowing (MOTIR-3581). Without that the
    // refusal would read "names no work item", about a row that plainly exists.
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'BETA',
    });
    const foreign = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'story', title: 'A story over there' },
      fx.ctx,
    );

    const planId = await openPlan(fx);
    const err = await rejection(() => appendReparent(fx, planId, card, foreign.id));

    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('illegal_parent');
    expect(err.message).toContain('DIFFERENT project');
    expect(await parentIdOf(card)).toBe(story);
  });

  it('ITSELF: a card may not be parented to itself', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedItem(fx, 'The epic', 'epic');
    const card = await seedItem(fx, 'The card', 'story', epic);

    const planId = await openPlan(fx);
    const err = await rejection(() => appendReparent(fx, planId, card, card));

    expect(err).toBeInstanceOf(PlanRefGraphError);
    expect((err as PlanRefGraphError).reason).toBe('cycle');
    expect(await parentIdOf(card)).toBe(epic);
  });

  it('A DESCENDANT: the move would close a cycle through the card own subtree', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedItem(fx, 'The epic', 'epic');
    const story = await seedItem(fx, 'The story', 'story', epic);
    const task = await seedItem(fx, 'The task', 'task', story);

    // Move the STORY under its own child.
    const planId = await openPlan(fx);
    const err = await rejection(() => appendReparent(fx, planId, story, task));

    expect(err).toBeInstanceOf(PlanRefGraphError);
    expect((err as PlanRefGraphError).reason).toBe('cycle');
    expect(err.message).toContain('DESCENDANT');
    expect(await parentIdOf(story)).toBe(epic);
  });

  it('THE DEPTH LIMIT: the resulting depth is the trigger own arithmetic, taken before the write', async () => {
    const fx = await makeWorkItemFixture();
    // epic(1) → story(2) → task(3) → bug(4). Anything under the bug is depth 5.
    const epic = await seedItem(fx, 'The epic', 'epic');
    const story = await seedItem(fx, 'The story', 'story', epic);
    const task = await seedItem(fx, 'The task', 'task', story);
    const bug = await seedItem(fx, 'The bug', 'bug', task);
    // A subtask living at depth 3, whose kind the matrix WOULD allow under a bug.
    const card = await seedItem(fx, 'The card', 'subtask', story);

    const planId = await openPlan(fx);
    const err = await rejection(() => appendReparent(fx, planId, card, bug));

    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('parent_depth_limit');
    expect(err.message).toContain('depth 5');
    expect(await parentIdOf(card)).toBe(story);
  });

  it('A `planItem:` TEMP-REF: a proposal is not a legal parent for a card that already exists', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seedItem(fx, 'The story', 'story');
    const card = await seedItem(fx, 'The card', 'subtask', story);

    const planId = await openPlan(fx);
    const err = await rejection(() =>
      appendReparent(fx, planId, card, `${TEMP_REF_PREFIX}whatever`),
    );

    expect(err).toBeInstanceOf(InvalidProposalError);
    expect(err.message).toContain('ALREADY');
    expect(await proposalCount(planId)).toBe(0);
  });

  it('A REF THAT NAMES NOTHING is a dangling ref, reported as one', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seedItem(fx, 'The story', 'story');
    const card = await seedItem(fx, 'The card', 'subtask', story);

    const planId = await openPlan(fx);
    const err = await rejection(() => appendReparent(fx, planId, card, 'cmqnosuchworkitemid00'));

    expect(err).toBeInstanceOf(PlanRefGraphError);
    expect((err as PlanRefGraphError).reason).toBe('dangling');
    expect(await proposalCount(planId)).toBe(0);
  });
});

describe('a re-parent onto a DONE parent is refused — and the point is what does NOT happen', () => {
  it('refuses with a typed error naming the parent status, and leaves the ancestor chain untouched', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedItem(fx, 'The epic', 'epic');
    const finished = await seedItem(fx, 'The finished story', 'story', epic);
    const home = await seedItem(fx, 'The open story', 'story', epic);
    const card = await seedItem(fx, 'The card', 'subtask', home);
    await markDone(fx, finished);

    const planId = await openPlan(fx);
    const err = await rejection(() => appendReparent(fx, planId, card, finished));

    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('parent_terminal');
    // The STATUS is named — the caller has to be able to tell this refusal from
    // the kind-matrix one without reading the source.
    expect(err.message).toContain('"done"');

    // ⚠️ THE ASSERTION THIS CASE EXISTS FOR. Status derivation recomputes a
    // container from its CURRENT child set and applies the result BACKWARD, so a
    // re-parent that landed would have walked `finished` — and every ancestor
    // above it — back out of `done`, dropping whatever was `blocked_by` them from
    // the ready set. Nothing moved.
    expect(await parentIdOf(card)).toBe(home);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: finished } });
    expect(after.status).toBe('done');
    expect(after.parentId).toBe(epic);
    expect(await adminDb.workItem.count({ where: { parentId: finished } })).toBe(0);
    expect(await proposalCount(planId)).toBe(0);
  });

  it('a CANCELLED parent is refused too — terminal is the CATEGORY, never the literal `done`', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedItem(fx, 'The epic', 'epic');
    const cancelled = await seedItem(fx, 'The cancelled story', 'story', epic);
    const home = await seedItem(fx, 'The open story', 'story', epic);
    const card = await seedItem(fx, 'The card', 'subtask', home);
    await workItemsService.updateStatus(cancelled, 'cancelled', fx.ctx);

    const planId = await openPlan(fx);
    const err = await rejection(() => appendReparent(fx, planId, card, cancelled));

    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('parent_terminal');
    expect(await parentIdOf(card)).toBe(home);
  });
});

describe('the approve re-takes the verdict — the world can move while the plan waits', () => {
  it('refuses at APPROVE a move whose new parent FINISHED after the plan was closed', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedItem(fx, 'The epic', 'epic');
    const target = await seedItem(fx, 'The story it would join', 'story', epic);
    const home = await seedItem(fx, 'The open story', 'story', epic);
    const card = await seedItem(fx, 'The card', 'subtask', home);

    const planId = await openPlan(fx);
    await appendReparent(fx, planId, card, target);
    await plansService.markPlanned(planId, fx.ctx);

    // …and only NOW does the new parent finish. The append could not have seen
    // this, which is exactly why the gate runs a second time under the approve
    // row locks rather than trusting the verdict it took at the close.
    await markDone(fx, target);

    const err = await rejection(() => plansService.approvePlan(planId, fx.ctx));
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('parent_terminal');
    expect(await parentIdOf(card)).toBe(home);
  });
});
