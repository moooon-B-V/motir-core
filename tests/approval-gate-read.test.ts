import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE FRAME'S READ (Story MOTIR-4778 · Subtask MOTIR-4792) — the one the
// approval frame renders from, against a REAL Postgres.
//
// What is load-bearing here, and why each assertion exists:
//
//   · SCOPED BY KIND. A card carrying a repository SET legitimately holds
//     SEVERAL simultaneous awaiting gates (ADR §6b's uniqueness is
//     `(workItemId, kind, subjectId)`), so a read that returned "the awaiting
//     gate" would hand the design section a merge gate the moment that kind
//     ships. This is the assertion that stops it.
//   · `canDecide` IS THE AUTHORITY ANSWER, NOT THE ROUTING ONE. A gate is SHOWN
//     to one person and may be PRESSED by three. A read that returned the
//     routing answer would draw state `B` — the port, no verbs — for a reporter
//     who is perfectly entitled to decide, and the work would sit there.
//   · IT AGREES WITH THE DOOR. `canDecide: true` from this read and a refusal
//     from `decide` is the one disagreement that matters: it draws verbs the
//     door then refuses. So the composition is asserted to be the same one.
//   · NO EXISTENCE LEAK. A cross-workspace card reads as "nothing awaiting",
//     never as a gate somebody else's tenant owns.

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

async function designSubtaskWithGate(
  opts: { assigneeId?: string | null; kind?: 'design_result' | 'pull_request_merge' } = {},
) {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Approve a design' },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the frame' },
    fx.ctx,
  );
  // The card has to be somewhere approval can legally take it to `done` — the
  // same walk the decide-door suite does. Without it the door's own effect
  // raises `IllegalTransitionError` from `todo`, which would make the
  // agrees-with-the-door assertion fail for a reason that has nothing to do with
  // authority.
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
        kind: opts.kind ?? 'design_result',
        subjectId: `design-evidence-${item.id}`,
      },
      tx,
    ),
  );
  return { story, item, gate };
}

describe('approvalGatesService.getAwaitingForWorkItem', () => {
  it('returns the awaiting gate of the KIND asked for', async () => {
    const { item, gate } = await designSubtaskWithGate();

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.gate?.id).toBe(gate.id);
    expect(read.gate?.state).toBe('awaiting');
    expect(read.gate?.kind).toBe('design_result');
  });

  it('does NOT return a gate of a DIFFERENT kind on the same card', async () => {
    // ⚠️ THE ONE THAT MATTERS AT SCALE. One card can carry a design gate and a
    // merge gate at once; a kind-blind read hands the design section the wrong
    // subject and it renders a merge decision inside a design port.
    const { item } = await designSubtaskWithGate({ kind: 'pull_request_merge' });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.gate).toBeNull();
    expect(read.canDecide).toBe(false);
  });

  it('returns nothing when the card has no gate at all — the ordinary case', async () => {
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Nothing pending' },
      fx.ctx,
    );

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: story.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.gate).toBeNull();
  });

  it('does not return a DECIDED gate — the awaiting set is what the verbs read', async () => {
    const { item, gate } = await designSubtaskWithGate();
    await approvalGatesService.decide({ gateId: gate.id, decision: 'request_changes' }, fx.ctx);

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.gate).toBeNull();
  });
});

describe('canDecide — the AUTHORITY answer, and it agrees with the door', () => {
  it('is true for the REPORTER even when the gate is routed to somebody else', async () => {
    // Routing is `assigneeId ?? reporterId` — ONE recipient. Authority is
    // assignee OR reporter OR admin. The fixture owner is the reporter here and
    // the assignee is a different member, so a read that returned the ROUTING
    // answer would say false.
    const other = await createTestUser();
    const { item } = await designSubtaskWithGate({ assigneeId: other.id });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );

    expect(read.gate).not.toBeNull();
    expect(read.canDecide).toBe(true);
  });

  it('agrees with the DOOR: a reader it says may decide is not refused by decide()', async () => {
    const other = await createTestUser();
    const { item, gate } = await designSubtaskWithGate({ assigneeId: other.id });

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      fx.ctx,
    );
    expect(read.canDecide).toBe(true);

    // ⚠️ THE AGREEMENT IS THE POINT. Drawing verbs the door then refuses is the
    // failure this pair exists to catch, and it can only be caught by running
    // BOTH — either half alone is self-consistent.
    const decided = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve' },
      fx.ctx,
    );
    expect(decided.gate.state).toBe('approved');
  });
});

describe('no existence leak', () => {
  it('reads as "nothing awaiting" for a card in another workspace', async () => {
    const { item } = await designSubtaskWithGate();
    const stranger = await makeWorkItemFixture();

    const read = await approvalGatesService.getAwaitingForWorkItem(
      { workItemId: item.id, kind: 'design_result' },
      stranger.ctx,
    );

    // Indistinguishable from a card that simply has no gate — the same posture
    // the decide door takes with its 404.
    expect(read.gate).toBeNull();
    expect(read.canDecide).toBe(false);
  });
});
