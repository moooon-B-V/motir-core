import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';

import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE for MOTIR-2786 — two sessions race one epic through a real
// hand-off, and the lock survives a crash.
// ═══════════════════════════════════════════════════════════════════════════
//
// MOTIR-2787 tests the lock against its own database. MOTIR-2788 tests the claim
// predicate against its own. That is exactly the shape this project keeps being
// caught by — two halves, each green against a fixture of the other, and the seam
// between them broken. A lock is unusually vulnerable to it, because both halves
// can be individually correct and the combination still wrong: the service can
// acquire properly and the planner can serialize properly, and the hand-off
// between epic and story can still leave a gap that only appears when two real
// sessions arrive at the same instant.
//
// So everything here goes through the SHIPPED ENTRANCES — the anchored
// `POST /api/work-items/[id]/ai/plan` route, the plan approve/decline routes, and
// the real Inngest sweep function — never the lock service directly. If the lock
// were wired to a method nobody calls, every test in MOTIR-2787 would still pass
// and every test here would fail.
//
// ⚠️ THE CONCURRENCY IS REAL, NOT SIMULATED, AND IT RUNS IN A LOOP. Two sequential
// calls to an acquire will pass against almost any implementation, including one
// with a check-then-act window wide enough to drive both sessions through. The
// window is the thing being tested, and a window has no meaning without
// simultaneity. Which racer loses is timing, so one round tests whichever path
// fired that morning.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () =>
    activeCtx.current
      ? { userId: activeCtx.current.userId, workspaceId: activeCtx.current.workspaceId }
      : null,
}));

// The motir-ai boundary — the one mock the no-mocks convention allows. Nothing
// about the lock lives on the far side of it.
const submitJobMock = vi.fn(async () => ({ jobId: 'job-1' }));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  getJob: vi.fn(),
  streamJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

const { POST: contextualPlanRoute } = await import('@/app/api/work-items/[id]/ai/plan/route');
const { POST: approvePlanRoute } = await import('@/app/api/plans/[id]/approve/route');
const { POST: declinePlanRoute } = await import('@/app/api/plans/[id]/decline/route');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { plansService } = await import('@/lib/services/plansService');
const { planTargetLockSweep } = await import('@/lib/jobs/definitions/planTargetLockSweep');
const { PLANNING_STATUS_KEY } = await import('@/lib/planChange/targetLock');

const BASE = 'http://localhost:3000';

let fx: WorkItemFixture;
const svcCtx = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId });

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  let n = 0;
  submitJobMock.mockImplementation(async () => ({ jobId: `job-${(n += 1)}` }));
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedItem(
  kind: 'epic' | 'story' | 'task' | 'subtask',
  title: string,
  parentId?: string,
) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, parentId: parentId ?? null },
    svcCtx(),
  );
}

/** A planning turn through the REAL anchored entrance — the route the panel
 *  posts to. Returns the response so a REFUSAL is inspectable rather than
 *  thrown away. */
async function planFrom(anchorId: string, targetKeys?: string[]): Promise<Response> {
  return contextualPlanRoute(
    new Request(`${BASE}/api/work-items/${anchorId}/ai/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Break this down', ...(targetKeys ? { targetKeys } : {}) }),
    }),
    { params: Promise.resolve({ id: anchorId }) },
  );
}

async function planOk(anchorId: string, targetKeys?: string[]): Promise<{ planId: string }> {
  const res = await planFrom(anchorId, targetKeys);
  // Read the body ONCE — a `Response` body is a stream, so quoting it in the
  // failure message and then parsing it consumes it twice.
  const body = await res.text();
  expect(res.status, body).toBe(200);
  return JSON.parse(body) as { planId: string };
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function heldItems(): Promise<string[]> {
  const rows = await adminDb.planTargetLock.findMany({
    where: { projectId: fx.projectId },
    orderBy: { workItemId: 'asc' },
    select: { workItemId: true },
  });
  return rows.map((r) => r.workItemId);
}

/** What the engine does with an accepted job, so the plan can be decided. */
async function engineProposes(planId: string, title: string): Promise<void> {
  await plansService.addProposals(
    planId,
    [{ op: 'add', proposedFields: { title, kind: 'story' } }],
    svcCtx(),
  );
  await plansService.markPlanned(planId, svcCtx());
}

async function approve(planId: string): Promise<void> {
  const res = await approvePlanRoute(new Request(`${BASE}/api/plans/${planId}/approve`), {
    params: Promise.resolve({ id: planId }),
  });
  expect(res.status, await res.text()).toBe(200);
}

async function decline(planId: string): Promise<void> {
  const res = await declinePlanRoute(new Request(`${BASE}/api/plans/${planId}/decline`), {
    params: Promise.resolve({ id: planId }),
  });
  expect(res.status).toBe(200);
}

/** Push every open lease into the past — the state a crashed planner leaves. It
 *  stands in for thirty minutes passing, and for nothing else: the RECOVERY under
 *  test is the shipped sweep, which is handed no help at all. */
async function ageAllLeases(): Promise<void> {
  await adminDb.planTargetLock.updateMany({ data: { expiresAt: new Date(Date.now() - 1_000) } });
}

describe('1 · the race, with genuine concurrency', () => {
  it('gives exactly one of two overlapping sessions the epic, and tells the other who has it', async () => {
    for (let round = 0; round < 5; round += 1) {
      await truncateAuthTables();
      fx = await makeWorkItemFixture();
      session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
      activeCtx.current = {
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        project: fx.project,
      };
      const epic = await seedItem('epic', `Billing ${round}`);
      const other = await seedItem('story', `Invoices ${round}`);

      // OVERLAPPING scopes, opened at the same instant through the real route.
      // Identical scopes resume ONE thread by design, so they are not the case the
      // lock exists for; `{epic}` versus `{epic, other}` is.
      const [a, b] = await Promise.all([planFrom(epic.id), planFrom(epic.id, [other.identifier])]);

      const statuses = [a.status, b.status].sort();
      expect(statuses, `round ${round}: one accepted, one refused`).toEqual([200, 409]);

      const refused = a.status === 409 ? a : b;
      const body = (await refused.json()) as {
        code: string;
        error: string;
        target: string;
        holder: string | null;
      };
      // A refusal a user cannot act on is not a refusal, it is a dead end: with a
      // multi-anchor scope they would not know WHICH target is taken, and with no
      // holder they would not know whom to ask or whether to wait.
      expect(body.code).toBe('PLAN_TARGET_LOCKED');
      expect(body.target).toBe(epic.identifier);
      expect(body.holder).toBe('Owner');
      expect(body.error).toContain(epic.identifier);

      // Exactly one lease, and exactly one thread — the refused open wrote nothing.
      expect(await heldItems()).toEqual([epic.id]);
      expect(await adminDb.planChangeSession.count()).toBe(1);
      expect(await statusOf(epic.id)).toBe(PLANNING_STATUS_KEY);
    }
  });
});

describe('2 · the hand-off, observed as a whole', () => {
  it('runs epic → stories → story, and lets a SECOND session take a different story meanwhile', async () => {
    const epic = await seedItem('epic', 'Billing');

    // ── The epic is the target ────────────────────────────────────────────
    const { planId } = await planOk(epic.id);
    expect(await statusOf(epic.id)).toBe(PLANNING_STATUS_KEY);
    expect(await heldItems()).toEqual([epic.id]);

    // ── Its stories exist ⇒ the epic goes back to `to do` ─────────────────
    await engineProposes(planId, 'Invoices');
    await approve(planId);
    expect(await statusOf(epic.id)).toBe('todo');
    expect(await heldItems()).toEqual([]);

    // The stories the approve materialized, plus one more to race on.
    const invoices = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Invoices' } });
    const refunds = await seedItem('story', 'Refunds', epic.id);

    // ── Breaking one story down takes ITS lock, and only its ──────────────
    await planOk(invoices.id);
    expect(await statusOf(invoices.id)).toBe(PLANNING_STATUS_KEY);
    expect(await statusOf(epic.id)).toBe('todo');

    // ── …while a second session takes a DIFFERENT story of the same epic ──
    // The case per-project serialization would have wrongly blocked, and the
    // reason MOTIR-2780 rejected it. Two people planning different stories of one
    // project is ordinary use, and it has to stay ordinary.
    await planOk(refunds.id);
    expect(await statusOf(refunds.id)).toBe(PLANNING_STATUS_KEY);
    expect(await heldItems()).toEqual([invoices.id, refunds.id].sort());
  });

  it('never leaves the epic held once its stories exist', async () => {
    // The half of the hand-off that is easy to get subtly wrong in the OTHER
    // direction: releasing upward has to actually happen, or a sibling story is
    // blocked for no reason and nobody notices until someone tries.
    const epic = await seedItem('epic', 'Billing');
    const { planId } = await planOk(epic.id);
    await engineProposes(planId, 'Invoices');
    await approve(planId);

    // A completely different session can now take the epic.
    await planOk(epic.id);
    expect(await statusOf(epic.id)).toBe(PLANNING_STATUS_KEY);
  });
});

describe('3 · the lock survives a crash', () => {
  it('releases a stranded target through the SHIPPED sweep, with no database edit', async () => {
    // The single most important assertion in the story. The race this lock
    // prevents produces a confusing tree a person can repair; a lock that is never
    // released produces an item NOBODY can plan again, discovered by a customer
    // rather than by us. Between a bug that degrades and a bug that traps, the
    // trap is the one worth spending the test on.
    //
    // And there is no product event to hang the release on: a plan whose job dies
    // stays `generating` forever — `PlanStatus` has no `failed` member — so the
    // session simply stops existing as far as anything downstream can tell.
    const epic = await seedItem('epic', 'Billing');
    await planOk(epic.id);
    expect(await statusOf(epic.id)).toBe(PLANNING_STATUS_KEY);

    // The planner dies here. Nothing marks the plan, nothing closes the thread.
    await ageAllLeases();

    const { result } = await new InngestTestEngine({ function: planTargetLockSweep }).execute();

    expect(result).toMatchObject({ released: 1 });
    expect(await statusOf(epic.id)).toBe('todo');
    expect(await heldItems()).toEqual([]);

    // …and the epic is plannable again by anyone, which is the property that
    // actually matters to the person who was locked out.
    await planOk(epic.id);
    expect(await statusOf(epic.id)).toBe(PLANNING_STATUS_KEY);
  });

  it('leaves a LIVE session alone — recovery must not become the race', async () => {
    const epic = await seedItem('epic', 'Billing');
    await planOk(epic.id);

    const { result } = await new InngestTestEngine({ function: planTargetLockSweep }).execute();

    expect(result).toMatchObject({ released: 0 });
    expect(await statusOf(epic.id)).toBe(PLANNING_STATUS_KEY);
    expect(await heldItems()).toEqual([epic.id]);
  });
});

describe('4 · the prior status is restored, not assumed', () => {
  it('round-trips `in_progress → planning → in_progress` through the real entrance', async () => {
    // Distinct from the `todo` case ON PURPOSE. The workflow allows
    // `in_progress ↔ planning`, so a release that hardcoded `todo` would silently
    // discard real progress — and it would pass every test written from a fresh
    // item, which is exactly the sort of test people write.
    const story = await seedItem('story', 'Invoices');
    await workItemsService.updateStatus(story.id, 'in_progress', svcCtx());

    const { planId } = await planOk(story.id);
    expect(await statusOf(story.id)).toBe(PLANNING_STATUS_KEY);

    await engineProposes(planId, 'Line items');
    await approve(planId);

    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('restores from `in_progress` on the DECLINE path too', async () => {
    // Decline is as terminal for the lock as approve, and it is the path where a
    // missed release would be hardest to notice: nothing was built, so nobody goes
    // looking at the tree afterwards.
    const story = await seedItem('story', 'Invoices');
    await workItemsService.updateStatus(story.id, 'in_progress', svcCtx());

    const { planId } = await planOk(story.id);
    // ⚠️ Assert the item was actually HELD before asserting it came back. Without
    // this line the case passes vacuously when the lock is removed — the item
    // never left `in_progress`, so "it is `in_progress`" is true for the wrong
    // reason. Measured: it was one of two cases that stayed green under the
    // lock-removal check, which is precisely the tell.
    expect(await statusOf(story.id)).toBe(PLANNING_STATUS_KEY);

    await engineProposes(planId, 'Line items');
    await decline(planId);

    expect(await statusOf(story.id)).toBe('in_progress');
    expect(await heldItems()).toEqual([]);
  });

  it('restores from `in_progress` when the SWEEP is what releases it', async () => {
    // The third combination, and the one no other case reaches: the crash path
    // signs its restore as a different actor and runs under a system context, so
    // "does it remember the prior status?" has to be asked of it separately.
    const story = await seedItem('story', 'Invoices');
    await workItemsService.updateStatus(story.id, 'in_progress', svcCtx());
    await planOk(story.id);
    // Held first — otherwise the restore assertion below is true for the wrong
    // reason (see the note on the decline case).
    expect(await statusOf(story.id)).toBe(PLANNING_STATUS_KEY);
    await ageAllLeases();

    const { result } = await new InngestTestEngine({ function: planTargetLockSweep }).execute();

    expect(result).toMatchObject({ released: 1 });
    expect(await statusOf(story.id)).toBe('in_progress');
  });
});
