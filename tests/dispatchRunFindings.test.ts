import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { dispatchRunEventInputSchema } from '@/lib/api/v1/workLoop/schema';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { DISPATCH_RUN_EVENT_LIMIT, dispatchRunService } from '@/lib/services/dispatchRunService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// WHAT THE RUN PRODUCED beyond code (Story MOTIR-1789 · MOTIR-3981) — the two
// findings the record learned to carry, against a real Postgres.
//
// `run-findings-protocol.md` Q5 settles the shape these assert: the SERVER
// writes them, they are CARD-scoped, they are best-effort, and no open leg means
// no event rather than an error. The file is organised by those properties
// rather than by method, because the interesting ones span the whole seam.

let fixture: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A STORY a run works — the shape a bug may legally be parented under. */
async function seedStory(title = 'A story a run works'): Promise<{ id: string; key: string }> {
  const story = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'story', title },
    fixture.ctx,
  );
  return { id: story.id, key: story.identifier };
}

/** A leaf under a fresh container, created through the real service. */
async function seedLeaf(title = 'A work item a run works'): Promise<{ id: string; key: string }> {
  const parent = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'story', title: 'A story a run works' },
    fixture.ctx,
  );
  const child = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'subtask', parentId: parent.id, title },
    fixture.ctx,
  );
  return { id: child.id, key: child.identifier };
}

/** A live run whose one leg is OPEN — `running`, `endedAt` still null. */
/**
 * Close a plan the way a real generation closes one — with something in it.
 *
 * ⚠️ THE PROPOSAL IS LOAD-BEARING (MOTIR-4124). A close over an EMPTY plan is a
 * DISCARD, and a discarded plan records NO `plan_submitted` finding: the finding
 * is the ASK — *a plan is waiting for you in Motir* — and nothing is waiting.
 * These fixtures used to close empty plans, which after that change would make
 * every "records nothing" case below pass for the WRONG REASON, proving nothing
 * about the anchoring walk each was written to test.
 */
async function closeWithProposal(planId: string): Promise<void> {
  await plansService.addProposals(
    planId,
    [{ op: 'add', proposedFields: { title: 'A proposed card', kind: 'task' } }],
    fixture.ctx,
  );
  await plansService.markPlanned(planId, fixture.ctx);
}

async function openRunWithLiveLeg(key: string): Promise<string> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command: 'run',
      cards: [{ key, disposition: 'queued' }],
    },
    fixture.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    [{ kind: 'card_claimed', workItemKey: key, disposition: 'running' }],
    fixture.ctx,
  );
  return run.id;
}

/** Every event on a run, in `seq` order, as the BROWSER reads them. */
async function readBack(runId: string) {
  const page = await dispatchRunService.readStreamPage(runId, 0, 500, fixture.ctx);
  return page.events;
}

describe('the SERVER records a finding on the leg that produced it', () => {
  it('a bug filed while a leg is open lands on THAT leg, read back through the DTO', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);

    // Q3's shape: a run-filed bug `relates_to` the in-flight work item — "the
    // parent says where the bug LIVES, the link says where it was FOUND".
    const bug = await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'bug',
        title: 'Prisma generate fails on a fresh clone',
        links: [{ relationship: 'relates_to', targetId: leaf.id }],
      },
      fixture.ctx,
    );

    const events = await readBack(runId);
    const finding = events.find((e) => e.kind === 'bug_filed');
    expect(finding).toBeDefined();

    // CARD-scoped: it hangs off the leg, not off the run. That is what lets the
    // canvas say WHICH work item produced it.
    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    expect(finding!.cardId).toBe(detail.cards[0]!.id);

    // The POINTER plus the one label a surface needs for a row it has not
    // fetched — never the description.
    expect(finding!.data).toEqual({
      key: bug.identifier,
      workItemId: bug.id,
      title: 'Prisma generate fails on a fresh clone',
    });
    expect(finding!.body).toBeNull();
  });

  it('several bugs from one run stay several events — nothing is collapsed', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);

    for (const title of ['first defect', 'second defect', 'third defect']) {
      await workItemsService.createWorkItem(
        {
          projectId: fixture.projectId,
          kind: 'bug',
          title,
          links: [{ relationship: 'relates_to', targetId: leaf.id }],
        },
        fixture.ctx,
      );
    }

    const findings = (await readBack(runId)).filter((e) => e.kind === 'bug_filed');
    expect(findings).toHaveLength(3);
    // Distinct `seq` — the stream's resume cursor never collides.
    expect(new Set(findings.map((f) => f.seq)).size).toBe(3);
    expect(findings.map((f) => (f.data as { title: string }).title)).toEqual([
      'first defect',
      'second defect',
      'third defect',
    ]);
  });

  it("anchors on the PARENT when that is what the bug points at — Q3's other arm", async () => {
    // Q3: where the in-flight work item has NO parent, the bug is parented
    // under the in-flight work item itself. Then the parent IS the anchor, and
    // there may be no `relates_to` to read.
    const leaf = await seedStory('The story the agent was working');
    const runId = await openRunWithLiveLeg(leaf.key);

    const bug = await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'bug',
        title: 'Parented under the work item it was found on',
        parentId: leaf.id,
      },
      fixture.ctx,
    );

    const findings = (await readBack(runId)).filter((e) => e.kind === 'bug_filed');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.data).toMatchObject({ workItemId: bug.id });
  });

  it('tries the relates_to trace BEFORE the parent, and records once', async () => {
    // A bug carrying both: the trace names the work item it was FOUND on, the
    // parent names where it LIVES. One finding, on the trace.
    const found = await seedLeaf('The work item the agent was working');
    const elsewhere = await seedStory('Where the bug lives');
    const runId = await openRunWithLiveLeg(found.key);

    const bug = await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'bug',
        title: 'Found here, living there',
        parentId: elsewhere.id,
        links: [{ relationship: 'relates_to', targetId: found.id }],
      },
      fixture.ctx,
    );

    const findings = (await readBack(runId)).filter((e) => e.kind === 'bug_filed');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.data).toMatchObject({ workItemId: bug.id });
  });

  it('a work item that is NOT a bug records nothing', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);

    await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'task',
        title: 'An ordinary task',
        links: [{ relationship: 'relates_to', targetId: leaf.id }],
      },
      fixture.ctx,
    );

    expect((await readBack(runId)).filter((e) => e.kind === 'bug_filed')).toHaveLength(0);
  });
});

describe('the AFTER-THE-FACT link reaches the same finding, once', () => {
  it('a bug linked after it was filed records the finding', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);

    // Filed with no trace — so nothing is recorded yet.
    const bug = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'bug', title: 'Found, then linked' },
      fixture.ctx,
    );
    expect((await readBack(runId)).filter((e) => e.kind === 'bug_filed')).toHaveLength(0);

    await workItemsService.linkWorkItems(
      { fromId: bug.id, toId: leaf.id, kind: 'relates_to' },
      fixture.ctx,
    );

    const findings = (await readBack(runId)).filter((e) => e.kind === 'bug_filed');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.data).toMatchObject({ workItemId: bug.id });
  });

  it('a bug created WITH its link and linked again records ONE finding', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);
    const bug = await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'bug',
        title: 'Filed with its trace',
        links: [{ relationship: 'relates_to', targetId: leaf.id }],
      },
      fixture.ctx,
    );

    // The reciprocal already exists, so the second link is refused as a
    // duplicate — but even reaching the recorder twice must not double the row.
    await workItemsService
      .linkWorkItems({ fromId: bug.id, toId: leaf.id, kind: 'relates_to' }, fixture.ctx)
      .catch(() => undefined);

    expect((await readBack(runId)).filter((e) => e.kind === 'bug_filed')).toHaveLength(1);
  });

  it('reads the bug on EITHER end of the link', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);
    const bug = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'bug', title: 'Linked from the work item' },
      fixture.ctx,
    );

    // The work item is the FROM and the bug is the TO — the mirror of the case
    // above, and the reciprocal `relates_to` makes both real edges.
    await workItemsService.linkWorkItems(
      { fromId: leaf.id, toId: bug.id, kind: 'relates_to' },
      fixture.ctx,
    );

    const findings = (await readBack(runId)).filter((e) => e.kind === 'bug_filed');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.data).toMatchObject({ workItemId: bug.id });
  });

  it('a non-`relates_to` link records nothing — the trace is that edge, not any edge', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);
    const bug = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'bug', title: 'Blocked by, rather than relates' },
      fixture.ctx,
    );

    await workItemsService.linkWorkItems(
      { fromId: bug.id, toId: leaf.id, kind: 'is_blocked_by' },
      fixture.ctx,
    );

    expect((await readBack(runId)).filter((e) => e.kind === 'bug_filed')).toHaveLength(0);
  });
});

describe('NO OPEN LEG MEANS NO EVENT — the ordinary case, not an error', () => {
  it('a bug filed with no run in flight is filed, and records nothing', async () => {
    const bug = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'bug', title: 'Filed by a person, in the app' },
      fixture.ctx,
    );

    // The write itself is untouched — this is the case that must never regress.
    expect(bug.id).toBeTruthy();
    const rows = await adminDb.dispatchRunEvent.findMany({ where: { kind: 'bug_filed' } });
    expect(rows).toHaveLength(0);
  });

  it('a bug filed after the leg ENDED belongs to no run', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'card_settled', workItemKey: leaf.key, disposition: 'implemented' }],
      fixture.ctx,
    );

    await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'bug',
        title: 'One millisecond too late',
        links: [{ relationship: 'relates_to', targetId: leaf.id }],
      },
      fixture.ctx,
    );

    expect((await readBack(runId)).filter((e) => e.kind === 'bug_filed')).toHaveLength(0);
  });

  it('a bug filed after the RUN closed belongs to no run', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);
    await dispatchRunService.close(runId, { stopReason: 'drained' }, fixture.ctx);

    await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'bug',
        title: 'After the run closed',
        links: [{ relationship: 'relates_to', targetId: leaf.id }],
      },
      fixture.ctx,
    );

    expect((await readBack(runId)).filter((e) => e.kind === 'bug_filed')).toHaveLength(0);
  });
});

describe('recording is BEST-EFFORT and may never be load-bearing', () => {
  it('a failing append does not fail the create, move a status or lose the bug', async () => {
    const leaf = await seedLeaf();
    await openRunWithLiveLeg(leaf.key);

    const boom = vi
      .spyOn(dispatchRunEventRepository, 'createMany')
      .mockRejectedValue(new Error('the record is down'));

    const bug = await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'bug',
        title: 'Filed while the record was down',
        links: [{ relationship: 'relates_to', targetId: leaf.id }],
      },
      fixture.ctx,
    );

    // The whole property: the write that TRIGGERED the finding is untouched.
    expect(bug.id).toBeTruthy();
    const stored = await adminDb.workItem.findUnique({ where: { id: bug.id } });
    expect(stored?.title).toBe('Filed while the record was down');

    // And the leg it would have landed on did not move.
    const leg = await adminDb.dispatchRunCard.findFirst({ where: { workItemId: leaf.id } });
    expect(leg?.disposition).toBe('running');
    expect(leg?.endedAt).toBeNull();

    boom.mockRestore();
  });

  it('stops at the run event LIMIT rather than pushing a run past it', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);

    // Mocked rather than seeded: the limit is 5,000 events and the branch is a
    // one-line guard, so writing five thousand rows to reach it would cost
    // seconds per run to assert nothing the mock does not.
    const full = vi
      .spyOn(dispatchRunEventRepository, 'countByRun')
      .mockResolvedValue(DISPATCH_RUN_EVENT_LIMIT);

    await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'bug',
        title: 'Filed onto a full run',
        links: [{ relationship: 'relates_to', targetId: leaf.id }],
      },
      fixture.ctx,
    );

    full.mockRestore();
    expect((await readBack(runId)).filter((e) => e.kind === 'bug_filed')).toHaveLength(0);
  });

  it('recordFinding answers `recorded: false` rather than throwing when there is no leg', async () => {
    const leaf = await seedLeaf();
    await expect(
      dispatchRunService.recordFinding(
        { anchorWorkItemId: leaf.id, kind: 'bug_filed', findingId: 'nope', data: { key: 'X-1' } },
        fixture.ctx,
      ),
    ).resolves.toEqual({ recorded: false });
  });
});

describe('a finding SURVIVES its target — the run history outlives the row', () => {
  it('reads back from the event alone after the bug is deleted', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);
    const bug = await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'bug',
        title: 'A defect somebody later deleted',
        links: [{ relationship: 'relates_to', targetId: leaf.id }],
      },
      fixture.ctx,
    );

    await adminDb.workItem.delete({ where: { id: bug.id } });

    // The read does not throw, and the row is still there with its recorded
    // key and title — which is what lets the surface render a finding whose
    // target is gone instead of dropping it.
    const finding = (await readBack(runId)).find((e) => e.kind === 'bug_filed');
    expect(finding).toBeDefined();
    expect(finding!.data).toMatchObject({
      key: bug.identifier,
      title: 'A defect somebody later deleted',
    });
    await expect(dispatchRunService.getRunDetail(runId, fixture.ctx)).resolves.toBeDefined();
  });

  it('reads back after the bug is ARCHIVED', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);
    const bug = await workItemsService.createWorkItem(
      {
        projectId: fixture.projectId,
        kind: 'bug',
        title: 'A defect somebody later archived',
        links: [{ relationship: 'relates_to', targetId: leaf.id }],
      },
      fixture.ctx,
    );
    await adminDb.workItem.update({
      where: { id: bug.id },
      data: { archivedAt: new Date() },
    });

    const finding = (await readBack(runId)).find((e) => e.kind === 'bug_filed');
    expect(finding).toBeDefined();
    expect(finding!.data).toMatchObject({ key: bug.identifier });
  });
});

describe('the INGEST refuses a client-reported finding — both directions', () => {
  // The forgery guard. The whole value of the record is that it says what
  // actually happened, and a run token that could append `bug_filed` could
  // assert a bug the run never filed.
  it('rejects `bug_filed` and `plan_submitted` on the append body', () => {
    for (const kind of ['bug_filed', 'plan_submitted']) {
      expect(dispatchRunEventInputSchema.safeParse({ kind }).success).toBe(false);
    }
  });

  it('still accepts every kind the CLI does emit', () => {
    for (const kind of ['card_claimed', 'agent_exited', 'leg_verdict', 'plan_approved', 'log']) {
      expect(dispatchRunEventInputSchema.safeParse({ kind }).success).toBe(true);
    }
  });
});

describe('the PLAN a run SUBMITTED — the ask the record could not name', () => {
  it('records the plan on the leg of the work item its thread is anchored at', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);

    // The shape a `motir plan --detach <KEY>` thread leaves behind: a
    // plan-change session anchored at exactly that key, whose `lastJobId` is
    // the plan's `sourceJobId`. This is the chain `approvePlanForWorkItem`
    // walks forward; the recorder walks it back.
    const jobId = `job_${leaf.key.toLowerCase()}`;
    await adminDb.planChangeSession.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        scopeKey: leaf.key,
        lastJobId: jobId,
      },
    });
    const plan = await plansService.createPlan(
      fixture.projectId,
      { title: 'The work item was wrong', sourceJobId: jobId },
      fixture.ctx,
    );
    await closeWithProposal(plan.id);

    const findings = (await readBack(runId)).filter((e) => e.kind === 'plan_submitted');
    expect(findings).toHaveLength(1);
    // The POINTER and the one number the row renders — what the reader is being
    // asked to approve. Never the proposals themselves.
    expect(findings[0]!.data).toEqual({ planId: plan.id, proposalCount: 1 });
    expect(findings[0]!.body).toBeNull();
  });

  it('records NOTHING for a plan that proposed nothing — a discard is not an ask (MOTIR-4124)', async () => {
    // The same anchoring chain as the case above, differing in exactly one
    // thing: the plan closes EMPTY. `markPlanned` discards it rather than
    // queueing it, so there is no plan waiting for anybody — and a finding
    // pointing a reviewer at a discarded plan is a promise the record cannot
    // keep. The anchoring is deliberately perfect here, so the only reason for
    // the empty result is the discard.
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);

    const jobId = `job_empty_${leaf.key.toLowerCase()}`;
    await adminDb.planChangeSession.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        scopeKey: leaf.key,
        lastJobId: jobId,
      },
    });
    const plan = await plansService.createPlan(
      fixture.projectId,
      { title: 'A pass that produced nothing', sourceJobId: jobId },
      fixture.ctx,
    );
    const closed = await plansService.markPlanned(plan.id, fixture.ctx);
    expect(closed.status).toBe('declined');

    expect((await readBack(runId)).filter((e) => e.kind === 'plan_submitted')).toHaveLength(0);
  });

  it('records nothing for a PROJECT-WIDE plan — it names no single leg', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);

    const jobId = 'job_project_wide';
    await adminDb.planChangeSession.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        // `PROJECT_SCOPE_KEY` — the empty anchor set. A plan submitted from the
        // project-wide panel belongs to no run, exactly as
        // `approvePlanForWorkItem` refuses to auto-approve one.
        scopeKey: '',
        lastJobId: jobId,
      },
    });
    const plan = await plansService.createPlan(
      fixture.projectId,
      { title: 'A project-wide plan', sourceJobId: jobId },
      fixture.ctx,
    );
    await closeWithProposal(plan.id);

    expect((await readBack(runId)).filter((e) => e.kind === 'plan_submitted')).toHaveLength(0);
  });

  it('records nothing for a MULTI-ANCHOR thread — it names no single leg either', async () => {
    const leaf = await seedLeaf();
    const other = await seedLeaf('A second work item');
    const runId = await openRunWithLiveLeg(leaf.key);

    const jobId = 'job_multi';
    await adminDb.planChangeSession.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        scopeKey: [leaf.key, other.key].sort().join(','),
        lastJobId: jobId,
      },
    });
    const plan = await plansService.createPlan(
      fixture.projectId,
      { title: 'A two-anchor plan', sourceJobId: jobId },
      fixture.ctx,
    );
    await closeWithProposal(plan.id);

    expect((await readBack(runId)).filter((e) => e.kind === 'plan_submitted')).toHaveLength(0);
  });

  it('records nothing when the source job has no plan-change session', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);
    const plan = await plansService.createPlan(
      fixture.projectId,
      { title: 'A job with no thread behind it', sourceJobId: 'job_orphan' },
      fixture.ctx,
    );
    await closeWithProposal(plan.id);

    expect((await readBack(runId)).filter((e) => e.kind === 'plan_submitted')).toHaveLength(0);
  });

  it('records nothing when the anchor key no longer resolves', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);

    const jobId = 'job_ghost_anchor';
    await adminDb.planChangeSession.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        // A key that never existed — the anchor a deleted work item leaves.
        scopeKey: `${fixture.projectIdentifier}-9999`,
        lastJobId: jobId,
      },
    });
    const plan = await plansService.createPlan(
      fixture.projectId,
      { title: 'Anchored at a work item that is gone', sourceJobId: jobId },
      fixture.ctx,
    );
    await closeWithProposal(plan.id);

    expect((await readBack(runId)).filter((e) => e.kind === 'plan_submitted')).toHaveLength(0);
  });

  it('records nothing for a plan with no source job at all', async () => {
    const leaf = await seedLeaf();
    const runId = await openRunWithLiveLeg(leaf.key);
    const plan = await plansService.createPlan(
      fixture.projectId,
      { title: 'A plan nobody generated' },
      fixture.ctx,
    );
    await closeWithProposal(plan.id);

    expect((await readBack(runId)).filter((e) => e.kind === 'plan_submitted')).toHaveLength(0);
  });
});

describe('a finding never crosses a workspace boundary', () => {
  it('a bug filed in one workspace does not land on another workspace’s run', async () => {
    // The anchor lookup filters on `workItemId` alone, so what keeps it inside
    // the tenant is the bound context plus `dispatch_run_card`'s own
    // workspace-column policy — not the query's `where`. This asserts the pair
    // rather than trusting either half.
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherStory = await workItemsService.createWorkItem(
      { projectId: other.projectId, kind: 'story', title: 'Their story' },
      other.ctx,
    );
    const { run: otherRun } = await dispatchRunService.open(
      {
        projectKey: other.projectIdentifier,
        command: 'run',
        cards: [{ key: otherStory.identifier, disposition: 'queued' }],
      },
      other.ctx,
    );
    await dispatchRunService.appendEvents(
      otherRun.id,
      [
        {
          kind: 'card_claimed',
          workItemKey: otherStory.identifier,
          disposition: 'running',
        },
      ],
      other.ctx,
    );

    // OUR context, naming THEIR work item as the anchor.
    await dispatchRunService.recordFinding(
      {
        anchorWorkItemId: otherStory.id,
        kind: 'bug_filed',
        findingId: 'forged',
        data: { key: 'OTHR-99', workItemId: 'forged', title: 'Not yours' },
      },
      fixture.ctx,
    );

    const rows = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: otherRun.id, kind: 'bug_filed' },
    });
    expect(rows).toHaveLength(0);
  });
});
