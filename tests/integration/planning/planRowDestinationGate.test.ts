import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { PLAN_STATUS_DTO_VALUES, type PlanStatusDto } from '@/lib/dto/plans';
import type { PlanApprovalSubjectSummaryDTO } from '@/lib/dto/approvalGate';
import { planRowDestination, type PlanRowDestination } from '@/lib/planning/planDestination';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// STORY GATE — A PLANS ROW GOES WHERE ITS PLAN IS (Story MOTIR-6043 · MOTIR-6047;
// design `design/ai-planning/design-notes.md` Part XXI; ADR `approval-gates.md` §11.5b).
//
// ⚠️ WHAT THIS FILE IS NOT. The RULE is a pure function and is covered at the unit tier
// over every `PlanStatus` × session-present cell, with its type-level totality assertion
// (`tests/planning/planDestination.test.ts`); the two ROWS are driven through it and
// compared against each other at the component tier
// (`tests/components/plan-row-destination-agreement.test.tsx`). Neither is re-asserted
// here.
//
// WHAT IS. The joint neither of those can reach: whether the two lists' READS actually
// SUPPLY the rule the three facts it needs, against real rows. The interesting inputs —
// a plan with no session, a stale plan, a session holding several plans, a plan whose
// gate is awaiting — are states the database holds, and a fixture that invents them
// proves only that the fixture was written to match the expectation.
//
// The failure this exists to catch is not a disagreement about the RULE. It is a read
// that quietly does not carry `sessionId`, or carries the wrong plan's status, and so
// falls back to the plan page: a row that looks like it works and goes to the wrong
// place. Both reads are therefore driven for the SAME plans, and their answers compared.
//
// Mocked: the motir-ai boundary (a Vitest process must not reach it) and nothing else.
// Every service, repository, trigger and index below is real.

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(),
  getJob: vi.fn(),
}));

const { plansService } = await import('@/lib/services/plansService');
const { planSessionsService } = await import('@/lib/services/planSessionsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { planDriftService } = await import('@/lib/services/planDriftService');
const { workItemsService } = await import('@/lib/services/workItemsService');

/** The address every row is composed onto — the page the list itself sits on. */
const PLANS_HOST = '/plans?planState=all';
const APPROVALS_HOST = '/workbench?tab=approvals';

let caller: V1ProjectCaller;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  vi.clearAllMocks();
  caller = await createV1ProjectCaller({
    permissions: ['project:browse', 'work_item:edit', 'ai:plan', 'ai:view_plan', 'ai:decide_plan'],
  });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = () => caller.ctx;
const fx = () => caller.fixture;

/** A plan with one proposal, written by the product — session attached in the same tx. */
async function plan(
  title: string,
  over: Parameters<typeof plansService.createPlan>[1] = {},
): Promise<string> {
  const created = await plansService.createPlan(fx().projectId, { title, ...over }, ctx());
  await plansService.addProposals(
    created.id,
    [{ op: 'add', proposedFields: { title: `${title} — a card`, kind: 'task' } }],
    ctx(),
  );
  return created.id;
}

/** …closed, which is what raises its `plan_approval` gate. */
async function closedPlan(title: string, over = {}): Promise<string> {
  const id = await plan(title, over);
  await plansService.markPlanned(id, ctx());
  return id;
}

/** The row the Plans page draws for a session, or undefined when it draws none. */
async function plansRow(sessionId: string) {
  const page = await planSessionsService.listSessions(fx().projectId, ctx());
  return page.sessions.find((s) => s.id === sessionId);
}

/** Every `plan_approval` subject the workbench queue read returns, by plan id. */
async function approvalSubjects(): Promise<Map<string, PlanApprovalSubjectSummaryDTO>> {
  const queue = await approvalGatesService.listAwaitingMe({
    userId: fx().ownerId,
    workspaceId: fx().workspaceId,
    projectId: fx().projectId,
  });
  const out = new Map<string, PlanApprovalSubjectSummaryDTO>();
  for (const row of queue.items) {
    if (row.subject?.kind === 'plan_approval') out.set(row.subject.planId, row.subject);
  }
  return out;
}

/** What the PLANS row would open, computed from what that read actually carried. */
function destinationFromPlansRow(
  row: NonNullable<Awaited<ReturnType<typeof plansRow>>>,
): PlanRowDestination {
  expect(row.latestPlan, 'the Plans read must carry the latest plan').not.toBeNull();
  return planRowDestination({
    planStatus: row.latestPlan!.status,
    planId: row.latestPlan!.id,
    sessionId: row.id,
    host: PLANS_HOST,
    anchorKey: row.targetKeys[0] ?? null,
  });
}

/** What the TO-APPROVE row would open, computed from what that read actually carried. */
function destinationFromApprovalSubject(
  subject: PlanApprovalSubjectSummaryDTO,
): PlanRowDestination {
  return planRowDestination({
    // Every row in this queue is `awaiting`, so its plan is undecided.
    planStatus: 'planned',
    planId: subject.planId,
    sessionId: subject.sessionId,
    host: APPROVALS_HOST,
    anchorKey: subject.targets[0]?.key ?? null,
    via: 'approvals',
  });
}

const overlayParams = (href: string) => {
  const url = new URL(href, 'http://x');
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (k.startsWith('plan') && k !== 'planState') out[k] = v;
  return out;
};

describe('SEAM: the PLANS read carries the rule its three facts', () => {
  it('five plans, five states — every row carries status + plan id + session, and lands where §11.5b says', async () => {
    const undecided = await closedPlan('undecided, with a conversation');
    const approved = await closedPlan('approved');
    await plansService.approvePlan(approved, ctx());
    const declined = await closedPlan('declined');
    await plansService.declinePlan(declined, ctx());

    // STALE, through the shipped drift path rather than by writing the status:
    // a plan proposing to modify a card whose status then goes terminal.
    const target = await workItemsService.createWorkItem(
      { projectId: fx().projectId, kind: 'task', title: 'A target' },
      ctx(),
    );
    const staleId = await plansService.createPlan(fx().projectId, { title: 'stale' }, ctx());
    await plansService.addProposals(
      staleId.id,
      [{ op: 'modify', workItemId: target.id, patch: { title: 'New' } }],
      ctx(),
    );
    await plansService.markPlanned(staleId.id, ctx());
    await planDriftService.markStaleForTerminalTarget(target.id, fx().workspaceId, {
      fromStatusKey: 'todo',
      toStatusKey: 'done',
    });

    const plans = await adminDb.plan.findMany({
      where: { projectId: fx().projectId },
      select: { id: true, status: true, sessionId: true },
    });
    const bySession = new Map(plans.map((p) => [p.sessionId!, p]));
    expect(bySession.size, 'each plan got its own session').toBe(4);

    const expected: Record<string, PlanRowDestination['kind']> = {
      [undecided]: 'planning-surface',
      [approved]: 'plan-page',
      [declined]: 'plan-page',
      [staleId.id]: 'planning-surface',
    };

    for (const [sessionId, row] of bySession) {
      const listed = await plansRow(sessionId);
      expect(listed, `the Plans read lists session ${sessionId}`).toBeDefined();
      // The three facts, read back off the DTO rather than off the fixture.
      expect(listed!.latestPlan).toEqual({
        id: row.id,
        status: row.status,
        title: expect.anything(),
      });
      expect(listed!.id).toBe(sessionId);

      const destination = destinationFromPlansRow(listed!);
      expect(destination.kind, `plan ${row.id} (${row.status})`).toBe(expected[row.id]);
      if (destination.kind === 'planning-surface') {
        expect(overlayParams(destination.href).planSession).toBe(sessionId);
      } else {
        expect(destination.href).toBe(`/plans/${row.id}`);
        expect(destination.reason).toBe('decided');
      }
    }
  });

  it('a session holding SEVERAL plans follows its LATEST, and the destination moves with it', async () => {
    const first = await closedPlan('the first plan');
    const sessionId = (await adminDb.plan.findUniqueOrThrow({ where: { id: first } })).sessionId!;
    await plansService.approvePlan(first, ctx());

    // A second plan ON THE SAME session — the refine shape (AMENDMENT 17 §5).
    const second = await plan('the second plan', { session: { sessionId } });
    expect(
      (await adminDb.plan.findUniqueOrThrow({ where: { id: second } })).sessionId,
      'the second plan joined the same session',
    ).toBe(sessionId);

    const row = await plansRow(sessionId);
    expect(row!.planCount).toBe(2);
    expect(row!.latestPlan!.id).toBe(second);
    // The latest is `generating`, so the row opens the conversation again even
    // though the session's earlier plan was approved.
    expect(destinationFromPlansRow(row!).kind).toBe('planning-surface');
  });
});

describe('SEAM: the APPROVAL QUEUE read carries the same three facts', () => {
  it('the same plan produces the same destination through both reads', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx().projectId, kind: 'story', title: 'The card the plan is about' },
      ctx(),
    );
    const planId = await closedPlan('one plan, two lists');
    const sessionId = (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).sessionId!;
    // Anchor the session at the card, so both reads have a target to carry.
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { targetKeys: [item.identifier] },
    });

    const subject = (await approvalSubjects()).get(planId);
    expect(subject, 'the raised gate reaches the queue read').toBeDefined();
    // The three facts, on the OTHER read.
    expect(subject!.sessionId).toBe(sessionId);
    expect(subject!.targets.map((t) => t.key)).toEqual([item.identifier]);

    const fromApprovals = destinationFromApprovalSubject(subject!);
    const fromPlans = destinationFromPlansRow((await plansRow(sessionId))!);

    expect(fromApprovals.kind).toBe('planning-surface');
    expect(fromPlans.kind).toBe('planning-surface');
    // ⚠️ THE ASSERTION THIS FILE EXISTS FOR: not that each is right, but that the
    // two agree. `planVia` is the one parameter only the To-approve row writes.
    const { planVia, ...rest } = overlayParams(fromApprovals.href);
    expect(planVia).toBe('approvals');
    expect(rest).toEqual(overlayParams(fromPlans.href));
  });
});

describe('GUARD: the no-conversation case, and what it is NOT', () => {
  // ⚠️ AMENDED on the record by this run (Story MOTIR-6043's settlement). The card
  // asked for *"an agent-authored plan (no session) seeded through the shipped path"*,
  // and that premise is false twice over: `plansService.createPlan` attaches a session
  // in the SAME transaction on EVERY path (AMENDMENT 17 §5), so no shipped path can
  // produce a plan without one — and an agent's plan is now precisely the case that
  // OPENS THE SURFACE (`docs/decisions/mcp-authored-plan-review.md`). So the Case
  // splits in two, and both halves are asserted.

  it('an MCP-authored plan HAS a session and opens the SURFACE, turns or no turns', async () => {
    const planId = await closedPlan('written by an agent', {
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
    });
    const row = await adminDb.plan.findUniqueOrThrow({
      where: { id: planId },
      include: { session: { select: { origin: true, turnCount: true } } },
    });

    expect(row.sessionId, 'the shipped path cannot write a plan without a session').not.toBeNull();
    expect(row.session!.turnCount, 'and the agent recorded no turns').toBe(0);

    const subject = (await approvalSubjects()).get(planId)!;
    expect(subject.sessionHasTurns).toBe(false);
    expect(destinationFromApprovalSubject(subject).kind).toBe('planning-surface');
    expect(destinationFromPlansRow((await plansRow(row.sessionId!))!).kind).toBe(
      'planning-surface',
    );
  });

  it('the ONLY no-session row is the rollout residue, and it reaches the To-approve list ALONE', async () => {
    const planId = await closedPlan('written during the rollout');
    const sessionId = (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).sessionId!;

    // ⚠️ WRITTEN BY HAND, and it has to be. `Plan.sessionId` is *"NULLABLE AT THE
    // DATABASE only so a build predating this column can still write a plan during a
    // rollout"* (`prisma/schema.prisma`), and every author path sets it — so this state
    // has no shipped producer to drive. Clearing the column IS the rollout, simulated.
    await adminDb.plan.update({ where: { id: planId }, data: { sessionId: null } });

    const subject = (await approvalSubjects()).get(planId);
    expect(
      subject,
      'a plan with no session still has a gate and still reaches To approve',
    ).toBeDefined();
    expect(subject!.sessionId).toBeNull();

    const destination = destinationFromApprovalSubject(subject!);
    expect(destination).toEqual({
      kind: 'plan-page',
      href: `/plans/${planId}`,
      reason: 'no-conversation',
    });

    // ⚠️ AND IT IS UNREACHABLE FROM THE PLANS PAGE (design § 21.3) — the structural
    // half of the settlement, asserted rather than asserted-about. The session survives
    // the plan leaving it, and it is listed; what it no longer has is a latest plan, so
    // the Plans page can never draw this state.
    const row = await plansRow(sessionId);
    expect(row, 'the session is still listed').toBeDefined();
    expect(row!.latestPlan, 'but it owns no plan, so no destination is computed').toBeNull();
  });
});

describe('GUARD: totality, measured against the statuses the DATABASE can hold', () => {
  it('every `PlanStatus` the enum admits is answered, and the two arms partition it', async () => {
    // The unit suite proves the function is total over the DTO's own vocabulary. This
    // asserts the vocabulary itself is the database's — a status the schema can store
    // and the DTO does not name would be a silent fall-through no unit test can see.
    const dbValues = await adminDb.$queryRawUnsafe<{ value: string }[]>(
      `SELECT unnest(enum_range(NULL::plan_status))::text AS value`,
    );
    expect(dbValues.map((r) => r.value).toSorted()).toEqual([...PLAN_STATUS_DTO_VALUES].toSorted());

    for (const planStatus of PLAN_STATUS_DTO_VALUES satisfies readonly PlanStatusDto[]) {
      for (const sessionId of ['s_1', null]) {
        const answer = planRowDestination({
          planStatus,
          planId: 'p_1',
          sessionId,
          host: PLANS_HOST,
        });
        expect(answer.kind, `${planStatus} / session=${sessionId}`).toBeDefined();
      }
    }
  });
});
