import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planValidityService } from '@/lib/services/planValidityService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ProposalInput } from '@/lib/dto/plans';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { NoActiveSprintError } from '@/lib/sprints/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// `planValidityService` (Story 7.28 · Subtask 7.28.1 / MOTIR-1386) over real
// Postgres — the PROJECTION-aware finishability engine. It answers the shipped
// validate_work_item / validate_sprint question over the live tree ⊕ a Plan's
// PlanItem delta, WITHOUT materializing. We assert each op kind (add/modify/
// remove), temp-ref resolution, loose vs tight, the remove-drops-edges case, and
// — critically — that the PROJECTION verdict equals the POST-materialize
// (approve) validate_work_item / validate_sprint verdict (the projection==
// materialize contract).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

const mk = (
  fx: WorkItemFixture,
  title: string,
  kind: 'story' | 'task' | 'subtask',
  parentId?: string,
) => workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);

const link = (fx: WorkItemFixture, fromId: string, toId: string) =>
  workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);

const putInSprint = (id: string, sprintId: string) =>
  db.workItem.update({ where: { id }, data: { sprintId } });

const markDone = (id: string) => db.workItem.update({ where: { id }, data: { status: 'done' } });

async function freshPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Plan' }, fx.ctx);
  return plan.id;
}

function addProposal(
  fx: WorkItemFixture,
  planId: string,
  proposal: ProposalInput,
): Promise<PlanWithItemsDto> {
  return plansService.addProposals(planId, [proposal], fx.ctx);
}

const itemIdByTitle = (plan: PlanWithItemsDto, title: string): string =>
  plan.items.find((i) => i.proposedFields?.title === title)!.id;

/** Make an ACTIVE sprint (createSprint + startSprint), returning its id. */
async function activeSprint(fx: WorkItemFixture): Promise<string> {
  const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
  await sprintsService.startSprint(sprint.id, {}, fx.ctx);
  return sprint.id;
}

describe('planValidityService.validateProjectedWorkItem — the projected subtree rule', () => {
  it('an `add` blocked_by an item OUTSIDE the target subtree is INVALID (loose) and names the real blocker', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const outside = await mk(fx, 'Outside', 'task'); // not in Story's subtree, not done

    const planId = await freshPlan(fx);
    const p = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'New child', kind: 'subtask' },
      parentRef: story.id,
      blockedByRefs: [outside.id],
    });
    await plansService.markPlanned(planId, fx.ctx);
    const addId = itemIdByTitle(p, 'New child');

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.key).toBe(story.identifier);
    expect(res.valid).toBe(false);
    expect(res.blockers).toEqual([
      {
        item: `planItem:${addId}`,
        blockedBy: outside.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('an out-of-subtree blocker that is DONE is satisfied under LOOSE but flagged under TIGHT', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const outside = await mk(fx, 'Outside done', 'task');
    await markDone(outside.id);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Child', kind: 'subtask' },
      parentRef: story.id,
      blockedByRefs: [outside.id],
    });
    await plansService.markPlanned(planId, fx.ctx);

    const loose = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
      'loose',
    );
    expect(loose.valid).toBe(true);
    expect(loose.blockers).toEqual([]);

    const tight = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
      'tight',
    );
    expect(tight.valid).toBe(false);
    expect(tight.blockers[0]?.blockedBy).toBe(outside.identifier);
  });

  it('an `add` whose blocker is ANOTHER add IN the subtree is VALID (temp-ref resolution, in-set)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const planId = await freshPlan(fx);
    const p1 = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Dep', kind: 'subtask' },
      parentRef: story.id,
    });
    const depId = itemIdByTitle(p1, 'Dep');
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Gated', kind: 'subtask' },
      parentRef: story.id,
      blockedByRefs: [`planItem:${depId}`], // intra-plan blocker, both under Story
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.valid).toBe(true);
    expect(res.blockers).toEqual([]);
  });

  it('a temp-ref blocker pointing at an add OUTSIDE the subtree is named as the `planItem:<id>` temp-ref', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const planId = await freshPlan(fx);
    // A backlog add (no parent) — outside Story's subtree, not done.
    const pDep = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Backlog dep', kind: 'task' },
    });
    const depId = itemIdByTitle(pDep, 'Backlog dep');
    const pGated = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Gated child', kind: 'subtask' },
      parentRef: story.id,
      blockedByRefs: [`planItem:${depId}`],
    });
    await plansService.markPlanned(planId, fx.ctx);
    const gatedId = itemIdByTitle(pGated, 'Gated child');

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.valid).toBe(false);
    expect(res.blockers).toEqual([
      {
        item: `planItem:${gatedId}`,
        blockedBy: `planItem:${depId}`,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('a `modify` adding an out-of-subtree blocked_by edge is INVALID, and the verdict EQUALS post-materialize validate_work_item', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const outside = await mk(fx, 'Outside', 'task'); // real, not done, not in subtree

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: child.id,
      patch: { blockedByAdd: [outside.id] },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const projected = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(projected.valid).toBe(false);
    expect(projected.blockers).toEqual([
      {
        item: child.identifier,
        blockedBy: outside.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);

    // Equivalence: materialize the SAME plan, then validate the real result.
    await plansService.approvePlan(planId, fx.ctx);
    const materialized = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
    );
    expect(materialized).toEqual(projected);
  });

  it('a `remove` drops the target node AND every edge touching it (a removed blocker no longer gates)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const outside = await mk(fx, 'Outside', 'task');
    await link(fx, child.id, outside.id); // LIVE: Child blocked_by Outside → live-invalid

    // Sanity: live (no plan) the story is invalid.
    const live = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(live.valid).toBe(false);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, { op: 'remove', workItemId: outside.id });
    await plansService.markPlanned(planId, fx.ctx);

    const projected = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(projected.valid).toBe(true);
    expect(projected.blockers).toEqual([]);

    // Equivalence: removing Outside (archive) makes the live verdict valid too.
    await plansService.approvePlan(planId, fx.ctx);
    const materialized = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
    );
    expect(materialized).toEqual(projected);
  });

  it('an unknown targetKey throws WorkItemNotFoundError; an unknown planId throws PlanNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);

    await expect(
      planValidityService.validateProjectedWorkItem(planId, 'MOTIR-999999', fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(
      planValidityService.validateProjectedWorkItem(
        'plan_does_not_exist',
        story.identifier,
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  // ── Validating a NEWLY-PROPOSED subtree by its temp-ref (MOTIR-1431) ──────────
  // The root may be a node THIS plan creates — a new story + its new subtasks —
  // not just an existing committed anchor.

  it('validates a NEW story (a proposed `add` root) by its `planItem:` temp-ref — VALID when its subtasks self-contain', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    // A whole new subtree: a new story, and two new subtasks under it (one gating the other).
    const pStory = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'New story', kind: 'story' },
    });
    const storyItemId = itemIdByTitle(pStory, 'New story');
    const pDep = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Schema', kind: 'subtask' },
      parentRef: `planItem:${storyItemId}`,
    });
    const depId = itemIdByTitle(pDep, 'Schema');
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Service', kind: 'subtask' },
      parentRef: `planItem:${storyItemId}`,
      blockedByRefs: [`planItem:${depId}`], // in-subtree blocker
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      `planItem:${storyItemId}`,
      fx.ctx,
    );
    expect(res.key).toBe(`planItem:${storyItemId}`);
    expect(res.valid).toBe(true);
    expect(res.blockers).toEqual([]);
  });

  it('a new story whose subtask is blocked_by an OUT-OF-SUBTREE backlog add is INVALID, named by temp-refs', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const pStory = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'New story', kind: 'story' },
    });
    const storyItemId = itemIdByTitle(pStory, 'New story');
    // A backlog add OUTSIDE the new story's subtree (no parent), not done.
    const pDep = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Backlog dep', kind: 'task' },
    });
    const depId = itemIdByTitle(pDep, 'Backlog dep');
    const pGated = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Gated subtask', kind: 'subtask' },
      parentRef: `planItem:${storyItemId}`,
      blockedByRefs: [`planItem:${depId}`],
    });
    const gatedId = itemIdByTitle(pGated, 'Gated subtask');
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      `planItem:${storyItemId}`,
      fx.ctx,
    );
    expect(res.valid).toBe(false);
    expect(res.blockers).toEqual([
      {
        item: `planItem:${gatedId}`,
        blockedBy: `planItem:${depId}`,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('an unknown `planItem:` temp-ref root throws WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await expect(
      planValidityService.validateProjectedWorkItem(planId, 'planItem:does_not_exist', fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('planValidityService.validateProjectedSprint — the projected sprint rule', () => {
  it('a `modify` making an in-sprint item blocked_by a new BACKLOG add is INVALID; the add is named by temp-ref', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const inSprint = await mk(fx, 'In sprint', 'task');
    await putInSprint(inSprint.id, sprintId);

    const planId = await freshPlan(fx);
    const pAdd = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'New backlog dep', kind: 'task' },
    });
    const addId = itemIdByTitle(pAdd, 'New backlog dep');
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: inSprint.id,
      patch: { blockedByAdd: [`planItem:${addId}`] },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedSprint(planId, fx.ctx);
    expect(res.sprintId).toBe(sprintId);
    expect(res.valid).toBe(false);
    expect(res.blockers).toEqual([
      {
        item: inSprint.identifier,
        blockedBy: `planItem:${addId}`,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('valid once the blocker is also IN the sprint (pulled in)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const inSprint = await mk(fx, 'In sprint', 'task');
    const blocker = await mk(fx, 'Blocker', 'task');
    await putInSprint(inSprint.id, sprintId);
    await putInSprint(blocker.id, sprintId); // blocker also in the sprint

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: inSprint.id,
      patch: { blockedByAdd: [blocker.id] },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedSprint(planId, fx.ctx);
    expect(res.valid).toBe(true);
    expect(res.blockers).toEqual([]);
  });

  it('the projected sprint verdict EQUALS post-materialize validate_sprint (a modify→backlog edge)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const inSprint = await mk(fx, 'In sprint', 'task');
    const backlog = await mk(fx, 'Backlog blocker', 'task'); // real, not in sprint, not done
    await putInSprint(inSprint.id, sprintId);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: inSprint.id,
      patch: { blockedByAdd: [backlog.id] },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const projected = await planValidityService.validateProjectedSprint(planId, fx.ctx);
    expect(projected.valid).toBe(false);
    expect(projected.blockers).toEqual([
      {
        item: inSprint.identifier,
        blockedBy: backlog.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    const materialized = await sprintsService.validateSprint(fx.projectId, null, fx.ctx);
    expect(materialized).toEqual(projected);
  });

  it('throws NoActiveSprintError when the project has no active sprint', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await expect(
      planValidityService.validateProjectedSprint(planId, fx.ctx),
    ).rejects.toBeInstanceOf(NoActiveSprintError);
  });
});
