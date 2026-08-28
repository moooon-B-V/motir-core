import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../../helpers/jobs';

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

async function planOk(
  anchorId: string,
  targetKeys?: string[],
): Promise<{ planId: string; sessionId: string }> {
  const res = await planFrom(anchorId, targetKeys);
  // Read the body ONCE — a `Response` body is a stream, so quoting it in the
  // failure message and then parsing it consumes it twice.
  const body = await res.text();
  expect(res.status, body).toBe(200);
  // `sessionId` comes back too, and it is the only handle on WHICH thread won —
  // the discriminator every all-or-nothing assertion below turns on.
  return JSON.parse(body) as { planId: string; sessionId: string };
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

/** The leases WITH their holder's thread — what `heldItems` cannot tell you.
 *  A row's `sessionId` is the only thing that separates "the winner holds its own
 *  scope" from "the loser leaked a lease", and the two produce the same id list. */
async function heldLeases(): Promise<Array<{ workItemId: string; sessionId: string }>> {
  return adminDb.planTargetLock.findMany({
    where: { projectId: fx.projectId },
    orderBy: { workItemId: 'asc' },
    select: { workItemId: true, sessionId: true },
  });
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
  // ⚠️ WHICH SESSION WINS IS TIMING, AND THE HELD SET IS DERIVED FROM IT — NEVER
  // ASSUMED (MOTIR-2971). The two racers do not reach the lock with equal effort:
  // `resolveScope` view-gates every anchor, so the `{epic, other}` opener makes one
  // extra `getWorkItemByIdentifier` round trip before it asks for the epic's row
  // lock. That handicap is why the `{epic}` opener wins essentially always on an
  // idle machine — and it is a handicap, not a rule. On a loaded runner the
  // ordering flips, the multi-anchor session wins, and it then holds BOTH of its
  // own anchors, which is the all-or-nothing contract working rather than failing.
  //
  // Asserting `heldItems() === [epic.id]` encoded the usual winner as the only
  // legal outcome, and CI duly failed once on run 32084804058 with the second
  // anchor present. The replacement below is STRICTLY STRONGER, not relaxed: it
  // reads the winner off the responses, requires the held set to be exactly that
  // winner's scope, and — the check the old one could not make at all — requires
  // every lease row to carry the WINNER's `sessionId`. A leaked lease from the
  // refused session produces the same id list and a different holder, so only this
  // form can tell the two apart.
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

      const multiAnchorWon = b.status === 200;
      const [accepted, refused] = multiAnchorWon ? [b, a] : [a, b];
      const won = (await accepted.json()) as { sessionId: string };
      const body = (await refused.json()) as {
        code: string;
        error: string;
        target: string;
        holder: string | null;
      };
      // A refusal a user cannot act on is not a refusal, it is a dead end: with a
      // multi-anchor scope they would not know WHICH target is taken, and with no
      // holder they would not know whom to ask or whether to wait. The epic is the
      // contended anchor either way — `other` is uncontended, so it can never be
      // what a refusal names.
      expect(body.code).toBe('PLAN_TARGET_LOCKED');
      expect(body.target).toBe(epic.identifier);
      expect(body.holder).toBe('Owner');
      expect(body.error).toContain(epic.identifier);

      // Exactly the WINNER's scope is held, by the WINNER's thread, and there is
      // exactly one thread — the refused open wrote nothing, whichever it was.
      const expectedHeld = multiAnchorWon ? [epic.id, other.id].sort() : [epic.id];
      const leases = await heldLeases();
      expect(
        leases.map((l) => l.workItemId),
        `round ${round}: held set is the winner's scope (multi-anchor won: ${multiAnchorWon})`,
      ).toEqual(expectedHeld);
      expect(
        leases.map((l) => l.sessionId),
        `round ${round}: every lease belongs to the winning thread`,
      ).toEqual(expectedHeld.map(() => won.sessionId));
      expect(await adminDb.planChangeSession.count()).toBe(1);
      expect(await statusOf(epic.id)).toBe(PLANNING_STATUS_KEY);
    }
  });
});

describe('1b · all-or-nothing, forced rather than raced (MOTIR-2971)', () => {
  // The race above is real concurrency and therefore proves whichever interleaving
  // fired. These three drive the SAME two openers through the entrance in a fixed
  // order, so each interleaving is asserted every run — including the one that
  // matters most and that no amount of racing reliably reaches: an acquire refused
  // PART-WAY through a multi-anchor scope.

  it('reproduces the CI reading — the multi-anchor session first holds BOTH its anchors', async () => {
    // `{epic, other}` opens first, so it wins the epic and legitimately takes the
    // second anchor too. This is byte-for-byte the state CI reported on run
    // 32084804058 (two lease rows where the assertion allowed one), and it is
    // CORRECT: both rows belong to the winning thread, and the refused session
    // holds nothing.
    const epic = await seedItem('epic', 'Billing');
    const other = await seedItem('story', 'Invoices');

    const winner = await planOk(epic.id, [other.identifier]);
    const refused = await planFrom(epic.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { target: string }).target).toBe(epic.identifier);

    const leases = await heldLeases();
    expect(leases.map((l) => l.workItemId)).toEqual([epic.id, other.id].sort());
    // The discriminator the id list cannot carry: ONE thread holds both, and it
    // is the WINNER's. A leaked lease from the refused open names the other one.
    expect(leases.map((l) => l.sessionId)).toEqual([winner.sessionId, winner.sessionId]);
    expect(await adminDb.planChangeSession.count()).toBe(1);
    expect(await statusOf(other.id)).toBe(PLANNING_STATUS_KEY);
  });

  it('a refused multi-anchor open leaves NO lease and NO thread behind', async () => {
    // The mirror order: `{epic}` opens first, so `{epic, other}` is refused. The
    // uncontended second anchor must come out of it untouched — asserted on the
    // table directly rather than inferred from a round loop.
    const epic = await seedItem('epic', 'Billing');
    const other = await seedItem('story', 'Invoices');

    const winner = await planOk(epic.id);
    const refused = await planFrom(epic.id, [other.identifier]);
    expect(refused.status).toBe(409);

    const leases = await heldLeases();
    expect(leases).toEqual([{ workItemId: epic.id, sessionId: winner.sessionId }]);
    expect(await adminDb.planTargetLock.count({ where: { workItemId: other.id } })).toBe(0);
    expect(await adminDb.planChangeSession.count()).toBe(1);
    expect(await statusOf(other.id)).toBe('todo');
  });

  it('an acquire refused on its SECOND anchor gives back the FIRST', async () => {
    // The actual all-or-nothing case, and the one the race can never produce: the
    // refusal has to land AFTER a lease has already been taken. Targets are locked
    // in ascending id order and `epic` was created first, so `{epic, other}` takes
    // the epic and is only then refused on `other` — and the epic's lease and its
    // `planning` status must both roll back with the transaction.
    //
    // A partial acquire here is the failure MOTIR-2786 called worse than the race
    // it prevents: the refused user is told about `other` and is silently holding
    // the epic, which nothing in the refusal names.
    const epic = await seedItem('epic', 'Billing');
    const other = await seedItem('story', 'Invoices');
    expect(epic.id < other.id, 'the epic must sort first for this to be the SECOND anchor').toBe(
      true,
    );

    const holder = await planOk(other.id);
    expect(await statusOf(other.id)).toBe(PLANNING_STATUS_KEY);

    const refused = await planFrom(epic.id, [other.identifier]);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { target: string }).target).toBe(other.identifier);

    expect(await heldLeases()).toEqual([{ workItemId: other.id, sessionId: holder.sessionId }]);
    expect(await adminDb.planTargetLock.count({ where: { workItemId: epic.id } })).toBe(0);
    expect(await statusOf(epic.id)).toBe('todo');
    expect(await adminDb.planChangeSession.count()).toBe(1);
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

    const { result } = await new JobTestEngine({ function: planTargetLockSweep }).execute();

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

    const { result } = await new JobTestEngine({ function: planTargetLockSweep }).execute();

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

    const { result } = await new JobTestEngine({ function: planTargetLockSweep }).execute();

    expect(result).toMatchObject({ released: 1 });
    expect(await statusOf(story.id)).toBe('in_progress');
  });
});
