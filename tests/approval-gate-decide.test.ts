import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateNotAuthorisedError,
  ApprovalGateNotFoundError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { makeWorkItemFixture, createTestLink, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE DECIDE DOOR (Story MOTIR-4778 · Subtask MOTIR-4790; ADR
// docs/decisions/approval-gates.md), against a REAL Postgres.
//
// The door is the one place a gate's state ever changes, for every kind that
// will ever exist, so what is asserted here is the SHARED half — the lock, the
// actor gate, the state refusals, the decision write — plus the one registered
// kind's effect. A per-kind test would prove the design gate works and say
// nothing about the claim the story rests on.
//
// The load-bearing assertions, in the order they were hardest to get right:
//
//   · THE RACE. Two decides on one gate produce exactly ONE decision, and the
//     loser receives `ApprovalGateAlreadyDecidedError` naming the winner and the
//     time. Driven with genuine concurrency against a warm pool — a serial
//     assertion passes with no lock at all, which is precisely the bug.
//   · THE EFFECT'S REACH. Approving does not merely flip a status: it must leave
//     a card `blocked_by` the design subtask CLAIMABLE in the same request. The
//     dependent's readiness is asserted BEFORE and AFTER, because a test that
//     only reads the subtask's own status would pass while the thing approval
//     exists to do had not happened.
//   · THE DISCRIMINATOR. `done` has exactly ONE writer (ADR §8). An approval on
//     a card with a linked OPEN pull request must write NO status and leave it
//     to the merge — the arm that, wired the other way, produces the
//     "approved but still in_review" collision the two workflows exist to end.
//   · THE TWO REFUSALS THAT LOOK ALIKE. A decided gate and a superseded one are
//     different sentences: somebody's answer, versus a withdrawn question.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A design subtask sitting in review with an `awaiting` design-result gate on
 *  it — the shape the publish path produces. */
async function designSubtaskWithGate(opts: { assigneeId?: string | null } = {}) {
  // A subtask must have a parent (`lib/issues/parentRules.ts`), which is also
  // the real shape: a design card hangs under the story it draws.
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Approve a design' },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the frame' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  if (opts.assigneeId !== undefined) {
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { assigneeId: opts.assigneeId },
    });
  }
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'design_result',
        subjectId: `design-evidence-${item.id}`,
      },
      tx,
    ),
  );
  return { story, item, gate };
}

describe('approvalGatesService.decide — approve, the terminal act (ADR §8 Workflow A)', () => {
  it('records the decision and returns the updated DTO', async () => {
    const { gate } = await designSubtaskWithGate();

    const before = Date.now();
    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', noteMd: 'Ship it.' },
      fx.ctx,
    );

    expect(result.gate.state).toBe('approved');
    expect(result.gate.decidedById).toBe(fx.ownerId);
    expect(result.gate.noteMd).toBe('Ship it.');
    expect(Date.parse(result.gate.decidedAt!)).toBeGreaterThanOrEqual(before - 1000);

    // Read the ROW back, not the DTO the call returned — a mapper that dropped a
    // field would agree with itself.
    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.state).toBe('approved');
    expect(row.decidedById).toBe(fx.ownerId);
    expect(row.decidedAt).not.toBeNull();
    expect(row.noteMd).toBe('Ship it.');
  });

  it('transitions the design subtask into the project done status THROUGH the one status funnel, and a dependent leaves `blocked` in the SAME request', async () => {
    const { story, item, gate } = await designSubtaskWithGate();

    // A card that cannot start until the design lands — the whole point of
    // approving one.
    const dependent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Build to the frame' },
      fx.ctx,
    );
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: dependent.id,
      toId: item.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    // BEFORE: the blocker is not done, so the dependent is not startable.
    await expect(workItemsService.isReady(dependent.id, fx.ctx)).resolves.toBe(false);

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve' },
      fx.ctx,
    );

    expect(result.effect.statusWritten).toBe('done');

    // AFTER: readiness is COMPUTED from the edges against the project's terminal
    // set, so this is the assertion that says approval actually unblocked work
    // rather than merely writing a word into a column.
    await expect(workItemsService.isReady(dependent.id, fx.ctx)).resolves.toBe(true);

    const moved = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(moved.status).toBe('done');
    // The `completedAt` stamp is inherited from `applyStatusTransition` — the
    // evidence that the move went through the one shipped status funnel rather
    // than a raw `work_item.status` write, which is the difference this card is
    // most likely to get wrong invisibly.
    expect(moved.completedAt).not.toBeNull();
  });

  it('the transition and the decision are ONE transaction — a failing effect rolls the decision back', async () => {
    const { item, gate } = await designSubtaskWithGate();
    // Cancel the card: `cancelled` is terminal and the default workflow has no
    // `cancelled → done` edge, so the effect's transition is refused.
    await workItemsService.updateStatus(item.id, 'cancelled', fx.ctx);

    await expect(
      approvalGatesService.decide({ gateId: gate.id, decision: 'approve' }, fx.ctx),
    ).rejects.toThrow();

    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.state).toBe('awaiting');
    expect(row.decidedById).toBeNull();
    expect(row.decidedAt).toBeNull();
  });
});

describe('approvalGatesService.decide — the DISCRIMINATOR: `done` has exactly one writer (ADR §8)', () => {
  it('a card with a linked OPEN pull request reaches NO status from the approval — the merge writes `done`', async () => {
    const { item, gate } = await designSubtaskWithGate();

    // The delivery row `link_pull_request` writes, with its pull request OPEN.
    // This is the set the discriminator READS — there is no setting and no field
    // on the card, which is what makes it impossible for a planner to get wrong.
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: 'inst-4790',
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        installationId: installation.id,
        repoId: 'repo-4790',
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 7,
        title: 'draw the frame',
        state: 'open',
        headRef: 'design/frame',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve' },
      fx.ctx,
    );

    // The DECISION still lands — that is the audit artefact, and the reviewer
    // did press the button.
    expect(result.gate.state).toBe('approved');
    // The STATUS does not. `done` belongs to the merge.
    expect(result.effect.statusWritten).toBeNull();
    expect(result.effect.statusDeferredReason).toBe('merge_writes_done');

    const unmoved = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unmoved.status).toBe('in_review');
    expect(unmoved.completedAt).toBeNull();
  });
});

describe('approvalGatesService.decide — request_changes records and moves NOTHING (ADR §3)', () => {
  it('records the decision and changes no work item status', async () => {
    const { item, gate } = await designSubtaskWithGate();

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'request_changes', noteMd: 'The port is too short.' },
      fx.ctx,
    );

    expect(result.gate.state).toBe('changes_requested');
    expect(result.gate.noteMd).toBe('The port is too short.');
    expect(result.effect.statusWritten).toBeNull();
    expect(result.effect.statusDeferredReason).toBe('request_changes_moves_nothing');

    const unmoved = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unmoved.status).toBe('in_review');
  });
});

describe('approvalGatesService.decide — CONCURRENCY: two presses, one decision', () => {
  it('two SIMULTANEOUS decides produce exactly one decision; the loser is told who won and when', async () => {
    const { gate } = await designSubtaskWithGate();

    // Genuine concurrency against a warm pool, NOT two serial calls. A
    // check-then-write with no `FOR UPDATE` passes a serial assertion perfectly
    // — it reads `awaiting` twice only when the two overlap, which is the
    // ordinary case on a shared queue and never the case in a serial test.
    const results = await Promise.allSettled([
      approvalGatesService.decide({ gateId: gate.id, decision: 'approve' }, fx.ctx),
      approvalGatesService.decide({ gateId: gate.id, decision: 'request_changes' }, fx.ctx),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // WHICH verb wins is the scheduler's business; the assertion pins the COUNT,
    // the TYPE and what the refusal CARRIES, never the identity of the winner.
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ApprovalGateAlreadyDecidedError);
    const err = reason as ApprovalGateAlreadyDecidedError;
    expect(['approved', 'changes_requested']).toContain(err.state);
    expect(err.decidedById).toBe(fx.ownerId);
    expect(err.decidedAt).toBeInstanceOf(Date);
    // The surface has to be able to SAY who and when, in place — a bare 409
    // cannot draw ADR §4's "somebody decided it while this was on screen".
    expect(err.message).toContain(err.decidedAt!.toISOString());

    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.state).toBe(err.state);
  });
});

describe('approvalGatesService.decide — state refusals', () => {
  it('a gate already decided is refused with the typed error, naming the decider and the time', async () => {
    const { gate } = await designSubtaskWithGate();
    await approvalGatesService.decide({ gateId: gate.id, decision: 'approve' }, fx.ctx);

    await expect(
      approvalGatesService.decide({ gateId: gate.id, decision: 'request_changes' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyDecidedError);
  });

  it('a `changes_requested` gate is refused with the SAME typed error', async () => {
    const { gate } = await designSubtaskWithGate();
    await approvalGatesService.decide({ gateId: gate.id, decision: 'request_changes' }, fx.ctx);

    await expect(
      approvalGatesService.decide({ gateId: gate.id, decision: 'approve' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyDecidedError);
  });

  it("a SUPERSEDED gate is a DIFFERENT refusal — a withdrawn question, not somebody's answer", async () => {
    const { gate } = await designSubtaskWithGate();
    // Nothing WRITES this state yet — the supersede predicate is MOTIR-4913's,
    // `blocked_by` this card. The door refuses it regardless, because the state
    // is in the Prisma enum today and a door that is total over its kinds owes
    // the same totality over its states.
    await adminDb.approvalGate.update({ where: { id: gate.id }, data: { state: 'superseded' } });

    await expect(
      approvalGatesService.decide({ gateId: gate.id, decision: 'approve' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateSupersededError);
  });

  it('an unknown gate id is a not-found', async () => {
    await expect(
      approvalGatesService.decide({ gateId: 'no-such-gate', decision: 'approve' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateNotFoundError);
  });
});

describe('approvalGatesService.decide — AUTHORITY is assignee OR reporter OR admin (ADR §2 amendment)', () => {
  it('the REPORTER may decide, even with no assignee', async () => {
    const { gate } = await designSubtaskWithGate({ assigneeId: null });
    // `fx.ownerId` is the reporter of everything the fixture creates.
    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve' },
      fx.ctx,
    );
    expect(result.gate.state).toBe('approved');
  });

  it('the ASSIGNEE may decide when they are not the reporter', async () => {
    const assignee = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: assignee.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    const { gate } = await designSubtaskWithGate({ assigneeId: assignee.id });

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve' },
      { userId: assignee.id, workspaceId: fx.workspaceId },
    );
    expect(result.gate.state).toBe('approved');
  });

  it('a workspace ADMIN may decide ANY work item — neither assignee nor reporter', async () => {
    const admin = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: admin.id, workspaceId: fx.workspaceId, role: 'admin' },
    });
    const { gate } = await designSubtaskWithGate({ assigneeId: null });

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve' },
      { userId: admin.id, workspaceId: fx.workspaceId },
    );
    expect(result.gate.state).toBe('approved');
  });

  it('a plain MEMBER who is neither assignee nor reporter is refused — and it is a 403-shaped refusal, not a 404', async () => {
    const bystander = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: bystander.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    const { gate } = await designSubtaskWithGate({ assigneeId: null });

    // They cleared the permission FLOOR (`work_item:edit` on an `open` project)
    // and failed the RELATIONSHIP test. Saying "not found" here would be a lie
    // the surface cannot render: they can see the gate perfectly well.
    await expect(
      approvalGatesService.decide(
        { gateId: gate.id, decision: 'approve' },
        { userId: bystander.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(ApprovalGateNotAuthorisedError);

    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(row.state).toBe('awaiting');
  });

  it('an actor who cannot BROWSE the project gets a not-found, so neither refusal leaks the other', async () => {
    // A `private` project admits only its own members. An outsider must not be
    // able to tell "this gate exists but you may not decide it" from "no such
    // gate" — finding #26's no-existence-leak posture, inherited from the shared
    // project gate rather than re-implemented here.
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { accessLevel: 'private' },
    });
    const outsider = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: outsider.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    const { gate } = await designSubtaskWithGate({ assigneeId: null });

    await expect(
      approvalGatesService.decide(
        { gateId: gate.id, decision: 'approve' },
        { userId: outsider.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('a VIEWER on a private project can browse but not edit — refused at the permission FLOOR, before the relationship test', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { accessLevel: 'private' },
    });
    const viewer = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: viewer.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    await adminDb.projectMembership.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        userId: viewer.id,
        role: 'viewer',
      },
    });
    const { gate } = await designSubtaskWithGate({ assigneeId: viewer.id });

    // Assigned to them, and still refused: the relationship rule is applied ON
    // TOP of the kind's permission floor, never instead of it.
    await expect(
      approvalGatesService.decide(
        { gateId: gate.id, decision: 'approve' },
        { userId: viewer.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('a gate in ANOTHER workspace is a not-found, never a permission error', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const { gate } = await designSubtaskWithGate();

    await expect(
      approvalGatesService.decide({ gateId: gate.id, decision: 'approve' }, other.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateNotFoundError);
  });
});
