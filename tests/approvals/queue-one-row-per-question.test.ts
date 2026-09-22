import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { homeService } from '@/lib/services/homeService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import type { HomeActorContext } from '@/lib/services/homeService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// ONE ROW PER QUESTION (Bug MOTIR-5712; `design-result.md` AMENDMENT 6 Q1, Q2, Q4),
// against a REAL Postgres.
//
// A design card with an open pull request holds TWO `awaiting` gates — the design
// gate (PRIMARY) and the merge gate it carries. One press on the design answers
// both, so every queue must list the card ONCE. Before this fix the tab, its badge,
// the home count and the Approvals room each counted the card twice and offered the
// merge row as a press of its own.
//
// Every read below runs over ONE fixture that also holds the shapes the rule must
// NOT touch — a card with only a merge gate, a card with only a design gate — so a
// predicate that dropped every merge gate, or every second gate, fails here too.

let fx: WorkItemFixture;
/** The reader: the fixture's owner, so the room's full view is open to them too. */
let meCtx: HomeActorContext;
let otherId: string;
let storyId: string;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  meCtx = { ...fx.ctx, projectId: fx.projectId };
  const other = await createTestUser({ email: 'other@ex.com', name: 'Other' });
  await workspacesService.addMember({ userId: other.id, workspaceId: fx.workspaceId });
  otherId = other.id;
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Designs with pull requests' },
    fx.ctx,
  );
  storyId = story.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** One card, assigned as given, carrying one `awaiting` gate per kind listed. */
async function cardWith(
  title: string,
  kinds: ApprovalGateKind[],
  assigneeId: string = meCtx.userId,
): Promise<{ id: string; gates: Record<string, string> }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: storyId, title },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId } });
  const gates: Record<string, string> = {};
  for (const kind of kinds) {
    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind,
          // The merge gate's subject IS the card; the design gate's is its evidence row.
          subjectId: kind === 'pull_request_approval' ? item.id : `evidence-${item.id}`,
        },
        tx,
      ),
    );
    gates[kind] = gate.id;
  }
  return { id: item.id, gates };
}

async function seed() {
  const both = await cardWith('Design with a PR', ['design_result', 'pull_request_approval']);
  const mergeOnly = await cardWith('Code card', ['pull_request_approval']);
  const designOnly = await cardWith('Design without a PR', ['design_result']);
  // Somebody else's two-gate card: invisible to the routed reads, visible to the
  // room's full view — where it must ALSO count once.
  const theirs = await cardWith(
    'Their design with a PR',
    ['design_result', 'pull_request_approval'],
    otherId,
  );
  return { both, mergeOnly, designOnly, theirs };
}

describe('the To approve tab lists a design card with a pull request ONCE', () => {
  it('lists the DESIGN gate and not the merge gate it carries — and leaves single-gate cards alone', async () => {
    const { both, mergeOnly, designOnly } = await seed();

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    expect(page.items.map((row) => row.gateId).sort()).toEqual(
      [
        both.gates.design_result,
        mergeOnly.gates.pull_request_approval,
        designOnly.gates.design_result,
      ].sort(),
    );
    expect(page.total).toBe(3);
  });

  it('the badge, the home count and the list agree on the same number', async () => {
    await seed();

    const listed = await approvalGatesService.listAwaitingMe(meCtx);
    const badge = await approvalGatesService.countAwaitingMe(meCtx);
    const home = await homeService.tabCounts(meCtx);

    expect(badge).toBe(3);
    expect(home.approvals).toBe(badge);
    expect(listed.items).toHaveLength(badge);
  });

  it('once the design is DECIDED the merge gate appears ALONE (Q2) — it was carried, never hidden for good', async () => {
    const { both } = await seed();
    await adminDb.approvalGate.update({
      where: { id: both.gates.design_result },
      data: { state: 'approved', decidedById: meCtx.userId, decidedAt: new Date() },
    });

    const page = await approvalGatesService.listAwaitingMe(meCtx);
    const onThisCard = page.items.filter((row) => row.workItem.id === both.id);

    expect(onThisCard.map((row) => row.gateId)).toEqual([both.gates.pull_request_approval]);
    expect(await approvalGatesService.countAwaitingMe(meCtx)).toBe(3);
  });

  it('a WITHDRAWN design gate carries nothing — the merge gate is the question again', async () => {
    const { both } = await seed();
    await adminDb.approvalGate.update({
      where: { id: both.gates.design_result },
      data: { state: 'superseded' },
    });

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    expect(
      page.items.filter((row) => row.workItem.id === both.id).map((row) => row.gateId),
    ).toEqual([both.gates.pull_request_approval]);
  });
});

describe('a DECISION card with a pull request is listed ONCE too (MOTIR-4907 · MOTIR-5681)', () => {
  it('lists the DECISION gate and not the merge gate its one press carries', async () => {
    const decision = await cardWith('Decide the page model', [
      'decision_approval',
      'pull_request_approval',
    ]);
    const mergeOnly = await cardWith('Code card', ['pull_request_approval']);

    const page = await approvalGatesService.listAwaitingMe(meCtx);

    expect(page.items.map((row) => row.gateId).sort()).toEqual(
      [decision.gates.decision_approval, mergeOnly.gates.pull_request_approval].sort(),
    );
    expect(await approvalGatesService.countAwaitingMe(meCtx)).toBe(2);
  });

  it('once the decision is DECIDED the merge gate appears alone', async () => {
    const decision = await cardWith('Decide the page model', [
      'decision_approval',
      'pull_request_approval',
    ]);
    await adminDb.approvalGate.update({
      where: { id: decision.gates.decision_approval },
      data: { state: 'approved', decidedById: meCtx.userId, decidedAt: new Date() },
    });

    const page = await approvalGatesService.listAwaitingMe(meCtx);
    expect(page.items.map((row) => row.gateId)).toEqual([decision.gates.pull_request_approval]);
  });
});

describe('the Approvals room lists the card ONCE in its pending section', () => {
  it('in the routed view', async () => {
    const { theirs } = await seed();
    // The other member holds no `approval:view_any`, so they see what is routed to them.
    const reader = { userId: otherId, workspaceId: fx.workspaceId, projectId: fx.projectId };

    const page = await approvalGatesService.listRecords(reader, { limit: 100 });

    expect(page.fullView).toBe(false);
    expect(page.sections.awaiting.items.map((row) => row.gateId)).toEqual([
      theirs.gates.design_result,
    ]);
    expect(page.sections.awaiting.total).toBe(1);
  });

  it('in the full view — every card of the project, each once', async () => {
    const { both, mergeOnly, designOnly, theirs } = await seed();

    const page = await approvalGatesService.listRecords(meCtx, { limit: 100 });

    expect(page.fullView).toBe(true);
    expect(page.sections.awaiting.items.map((row) => row.gateId).sort()).toEqual(
      [
        both.gates.design_result,
        mergeOnly.gates.pull_request_approval,
        designOnly.gates.design_result,
        theirs.gates.design_result,
      ].sort(),
    );
    expect(page.sections.awaiting.total).toBe(4);
    expect(page.total).toBe(4);
  });
});
