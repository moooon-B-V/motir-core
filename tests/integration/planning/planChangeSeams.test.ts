import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { planningWorkspaceHref, type PlanningLaunchContext } from '@/lib/planning/launcher';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// The Story-7.30 INTEGRATION SEAMS (MOTIR-1732) — the joints BETWEEN this
// story's four subtasks, driven with each side's REAL implementation against a
// real Postgres. Every subtask ships its own units (MOTIR-1728/1729/1730/1731);
// what no unit can see is KEY DRIFT across a boundary, because each side's units
// assert against their own fixture of the other side's shape.
//
// The three joints, in the order a user crosses them:
//
//   1. LAUNCHER → HOST. `planningWorkspaceHref()` (MOTIR-1729's launcher half)
//      writes a query; the `/planning` ROUTE reads it back. The pure round trip
//      is unit-tested; what is NOT is that the route actually WIRES the parse,
//      the gate and the back-href into the props the host renders from. So this
//      drives the real page module over a real project row.
//
//   2. CONVERSATION → JOB. The thread's ACCUMULATED intent (MOTIR-1728) is what
//      the plan-edit job receives — every user turn in order, across a RESUME,
//      not just the latest message. Driven through the real HTTP handlers so the
//      route → service → repository → Postgres chain is the thing under test;
//      only motir-ai's boundary client is stubbed.
//
//   3. THE RUN'S PROPOSALS → APPROVE → THE TREE. What a plan-edit job actually
//      produces is `PlanItem` proposals appended to the run's `Plan` (its
//      handlers return an always-empty `planDelta` — MOTIR-1747), so the joint is
//      submit → the engine's proposal callback → `POST /api/plans/[id]/approve` →
//      materialize. The delta approve this seam used to drive is GONE: there is
//      exactly one proposal→tree write path now, and this is it.
//
// Determinism: no timers, no `waitForTimeout`, no ordering between tests (every
// test builds its own tenant after a truncate).

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
// The plan approve/decline routes resolve the WORKSPACE (not the active
// project); the node test env has no cookies to resolve it from, so it is
// stubbed to the same tenant the session is in — the one `getSession` mock's
// sibling, no more.
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () =>
    activeCtx.current
      ? { userId: activeCtx.current.userId, workspaceId: activeCtx.current.workspaceId }
      : null,
}));

// The motir-ai BOUNDARY — the one mock the convention allows. `submitJob`
// records what the engine would receive; `getJob` replays what it would return.
const submitJobMock = vi.fn(async () => ({ jobId: 'job-augment-1' }));
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
  streamJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  indexCodeGraph: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

// next-intl's server helper needs a request-scoped i18n config the node test env
// has no request for; echo the key so a copy assertion is impossible by
// construction (this file asserts WIRING, never strings).
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

/** `redirect()` throws in Next; make the throw inspectable instead of opaque. */
class TestRedirect extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new TestRedirect(to);
  },
}));

const { POST: openSessionRoute } = await import('@/app/api/ai/plan-change/session/route');
const { POST: appendTurnRoute } = await import('@/app/api/ai/plan-change/session/turns/route');
const { POST: submitRoute } = await import('@/app/api/ai/plan-change/session/submit/route');
const { POST: approvePlanRoute } = await import('@/app/api/plans/[id]/approve/route');
const { default: PlanningWorkspacePage } = await import('@/app/(planning)/planning/page');

const BASE = 'http://localhost:3000';

function post(path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The searchParams Next hands a page, built from the href the LAUNCHER emits —
 *  the seam itself: nothing here restates the query by hand. */
function searchParamsFrom(context: PlanningLaunchContext): Record<string, string> {
  const url = new URL(planningWorkspaceHref(context), BASE);
  return Object.fromEntries(url.searchParams.entries());
}

/** Render the `/planning` Server Component and return the host element's props. */
async function renderPlanningPage(context: PlanningLaunchContext) {
  const element = (await PlanningWorkspacePage({
    searchParams: Promise.resolve(searchParamsFrom(context)),
  })) as { type: unknown; props: Record<string, unknown> };
  return element;
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-augment-1' });
  getJobMock.mockReset();
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
});

/**
 * Seed a pre-existing item through the SERVICE, not the raw fixture helper: the
 * approve path appends siblings with `generateKeyBetween`, which rejects the
 * fixture's zero-padded stand-in positions. Only real fractional positions make
 * the "approve into a tree that already has items" case run at all.
 */
async function seedItem(input: {
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask';
  title: string;
  parentId?: string | null;
}) {
  const { workItemsService } = await import('@/lib/services/workItemsService');
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: input.kind,
      title: input.title,
      parentId: input.parentId ?? null,
    },
    { userId: fx.ownerId, workspaceId: fx.workspaceId },
  );
}

/** Mark the fixture project established, as finishing onboarding does. */
async function markOnboarded(): Promise<void> {
  const onboardingRanAt = new Date('2026-07-01T10:00:00Z');
  await db.project.update({ where: { id: fx.projectId }, data: { onboardingRanAt } });
  // The context the page reads carries the DTO form (an ISO string), so patch
  // the marker on the DTO rather than swapping in the raw Prisma row.
  activeCtx.current = {
    ...activeCtx.current!,
    project: { ...activeCtx.current!.project, onboardingRanAt: onboardingRanAt.toISOString() },
  };
}

// ───────────────────────── Seam 1 — launcher → host ─────────────────────────

describe('seam · the launcher’s href is what the /planning HOST resolves', () => {
  it('carries a project launch’s mode + origin from the href into the host’s props', async () => {
    await markOnboarded();

    const element = await renderPlanningPage({ kind: 'project', hasPlan: true });

    // The contract that had NO consumer when it was written: the route parses
    // exactly what the launcher wrote.
    expect(element.props['launch']).toEqual({
      mode: 'replan',
      from: 'project',
      itemKey: null,
      repoKey: null,
    });
    expect(element.props['backHref']).toBe('/roadmap');
    expect(element.props['projectKey']).toBe(fx.project.identifier);
    expect(element.props['projectName']).toBe(fx.project.name);
  });

  it('carries a work-item launch’s target key through to the host and its Close href', async () => {
    await markOnboarded();

    const element = await renderPlanningPage({ kind: 'work-item', itemKey: 'PROD-7' });

    expect(element.props['launch']).toEqual({
      mode: 'contextual',
      from: 'work-item',
      itemKey: 'PROD-7',
      repoKey: null,
    });
    // The origin the user came from — resolved from the SAME parsed context,
    // not re-derived by the page.
    expect(element.props['backHref']).toBe('/items/PROD-7');
  });

  it('carries a convention-refine launch’s repo key and returns to code health', async () => {
    await markOnboarded();

    const element = await renderPlanningPage({
      kind: 'convention-refine',
      repoKey: 'moooon/motir-core',
    });

    expect(element.props['launch']).toEqual({
      mode: 'contextual',
      from: 'convention-refine',
      itemKey: null,
      repoKey: 'moooon/motir-core',
    });
    expect(element.props['backHref']).toBe('/code-health');
  });

  it('reports whether the REAL project tree has anything for the canvas to draw', async () => {
    await markOnboarded();

    const empty = await renderPlanningPage({ kind: 'project' });
    expect(empty.props['hasItems']).toBe(false);

    await seedItem({ kind: 'epic', title: 'Billing' });

    const populated = await renderPlanningPage({ kind: 'project' });
    expect(populated.props['hasItems']).toBe(true);
  });

  it('FORWARDS a never-onboarded project to /onboarding — the gate is not bypassed', async () => {
    // The fixture project has a null `onboardingRanAt`, which is the first-run
    // state. `/onboarding` keeps owning it; the host is an additional surface.
    await expect(renderPlanningPage({ kind: 'project', hasPlan: true })).rejects.toBeInstanceOf(
      TestRedirect,
    );
    await expect(renderPlanningPage({ kind: 'project', hasPlan: true })).rejects.toMatchObject({
      to: '/onboarding',
    });
  });

  it('bounces a signed-out visitor to sign-in before any project read', async () => {
    session.current = null;
    await expect(renderPlanningPage({ kind: 'project' })).rejects.toMatchObject({ to: '/sign-in' });
  });

  it('renders the pick-a-project state with no active project, never a crash', async () => {
    await markOnboarded();
    activeCtx.current = null;

    const element = await renderPlanningPage({ kind: 'project' });
    // Not the host — the empty state. The host is only mounted for a project.
    expect(element.props).not.toHaveProperty('launch');
  });
});

// ─────────────────── Seam 2 — the thread → what the job gets ───────────────────

describe('seam · the ACCUMULATED thread is what the plan-edit job receives', () => {
  it('sends every turn of a RESUMED conversation, in order, over the real routes', async () => {
    // Turn one, then the workspace is closed (a fresh open/resume), then turn
    // two. If the accumulation lived in component state rather than the row,
    // turn one would be gone by submit — the exact failure the seam exists for.
    await openSessionRoute();
    await appendTurnRoute(
      post('/api/ai/plan-change/session/turns', { body: 'Add auth to the billing epic' }),
    );

    const resumed = await openSessionRoute();
    const resumedBody = (await resumed.json()) as { turns: Array<{ body: string }> };
    expect(resumedBody.turns.map((t) => t.body)).toEqual(['Add auth to the billing epic']);

    await appendTurnRoute(
      post('/api/ai/plan-change/session/turns', { body: 'Make the subtasks smaller' }),
    );
    const submitted = await submitRoute();
    expect(submitted.status).toBe(200);

    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const [kind, tenant, payload] = submitJobMock.mock.calls[0] as unknown as [
      string,
      { projectId: string; workspaceId: string; projectKey: string },
      { prompt: string },
    ];

    // The shipped job kind — the conversation adds none.
    expect(kind).toBe('augment');
    expect(tenant.projectId).toBe(fx.projectId);
    expect(tenant.workspaceId).toBe(fx.workspaceId);
    expect(tenant.projectKey).toBe(fx.project.identifier);

    // Both turns, EARLIEST FIRST — the ordering the engine's "later turns refine
    // earlier ones" framing depends on.
    const first = payload.prompt.indexOf('Add auth to the billing epic');
    const second = payload.prompt.indexOf('Make the subtasks smaller');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  it('records the submitted intent VERBATIM on the thread, tied to the job', async () => {
    // The thread carries its own provenance: what went out, and which job it
    // became. A resumed rail re-attaches to that job from this marker.
    await openSessionRoute();
    await appendTurnRoute(post('/api/ai/plan-change/session/turns', { body: 'Split the epic' }));
    const res = await submitRoute();
    const body = (await res.json()) as {
      jobId: string;
      session: { lastJobId: string; turns: Array<{ role: string; body: string; jobId: string }> };
    };

    const [, , payload] = submitJobMock.mock.calls[0] as unknown as [
      string,
      unknown,
      { prompt: string },
    ];
    const marker = body.session.turns.at(-1)!;
    expect(marker.role).toBe('system');
    expect(marker.body).toBe(payload.prompt);
    expect(marker.jobId).toBe(body.jobId);
    expect(body.session.lastJobId).toBe(body.jobId);
  });

  it('sends a ONE-turn thread byte-identically to the retired one-shot prompt', async () => {
    // MOTIR-1731 retired "Augment from prompt". A single-turn conversation must
    // reach the engine as exactly that prompt — no conversational framing that
    // would shift the engine's behaviour for the simplest case.
    await openSessionRoute();
    await appendTurnRoute(
      post('/api/ai/plan-change/session/turns', { body: 'Add a payments epic' }),
    );
    await submitRoute();

    const [, , payload] = submitJobMock.mock.calls[0] as unknown as [
      string,
      unknown,
      { prompt: string },
    ];
    expect(payload.prompt).toBe('Add a payments epic');
  });
});
// ────────── Seam 3 — the run's PROPOSALS → approve the plan → the tree ──────────

describe('seam · the run’s proposals approve through the 7.21 substrate into the tree', () => {
  const svcCtx = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId });

  /** Play back what motir-ai does with a submitted job: append the run's
   *  proposals to the Plan the submit opened, then close the frontier. This is
   *  the REAL seam (`plansService.addProposals` → `markPlanned`, the same calls
   *  `aiGenerationService.appendProposals` makes on the engine's callback) — only
   *  the network hop is elided, because motir-ai is absent from CI. */
  async function engineProposes(
    planId: string,
    proposals: Parameters<typeof plansService.addProposals>[1],
  ): Promise<void> {
    await plansService.addProposals(planId, proposals, svcCtx());
    await plansService.markPlanned(planId, svcCtx());
  }

  const approvePlan = (planId: string) =>
    approvePlanRoute(post(`/api/plans/${planId}/approve`), {
      params: Promise.resolve({ id: planId }),
    });

  it('runs the whole loop: converse → submit → the run’s proposals → approve → work items', async () => {
    const epic = await seedItem({ kind: 'epic', title: 'Billing' });

    await openSessionRoute();
    await appendTurnRoute(
      post('/api/ai/plan-change/session/turns', { body: 'Add auth to the billing epic' }),
    );
    await appendTurnRoute(
      post('/api/ai/plan-change/session/turns', { body: 'And retitle the epic' }),
    );
    const submitted = await submitRoute();
    const { jobId, planId } = (await submitted.json()) as { jobId: string; planId: string };

    // The submit opened the run's Plan and bound it to the job — the fact the
    // whole review path turns on (MOTIR-1743/1745). Nothing about a delta.
    expect(planId).toBeTruthy();
    const opened = await db.plan.findUnique({ where: { id: planId } });
    expect(opened?.sourceJobId).toBe(jobId);
    expect(opened?.status).toBe('generating');

    // Appended in two batches, as the engine really appends them: the second
    // batch's parent is an intra-plan temp-ref to an item from the first.
    const first = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Authentication', kind: 'story', priority: 'high' },
          parentRef: epic.id,
        },
      ],
      svcCtx(),
    );
    const storyItemId = first.items[0]!.id;
    await engineProposes(planId, [
      {
        op: 'add',
        proposedFields: { title: 'Session cookies', kind: 'subtask', estimateMinutes: 45 },
        parentRef: `${TEMP_REF_PREFIX}${storyItemId}`,
      },
      { op: 'modify', workItemId: epic.id, patch: { title: 'Billing & Auth' } },
    ]);

    const approved = await approvePlan(planId);
    expect(approved.status).toBe(200);

    // …and the tree really changed. Read it back from the database, not from the
    // approve response — the response is the claim, the rows are the fact (the
    // read-back-through-the-next-consumer rule).
    const rows = await db.workItem.findMany({
      where: { projectId: fx.projectId },
      orderBy: { createdAt: 'asc' },
    });
    const byTitle = new Map(rows.map((r) => [r.title, r]));

    expect(byTitle.get('Billing & Auth')?.id).toBe(epic.id);
    const authStory = byTitle.get('Authentication')!;
    expect(authStory.kind).toBe('story');
    expect(authStory.parentId).toBe(epic.id);
    expect(authStory.priority).toBe('high');

    // The intra-plan temp-ref resolved to the item created EARLIER IN THE SAME
    // plan — the ref table only a multi-proposal approve exercises.
    const subtask = byTitle.get('Session cookies')!;
    expect(subtask.kind).toBe('subtask');
    expect(subtask.parentId).toBe(authStory.id);
    expect(subtask.estimateMinutes).toBe(45);

    // The run is DECIDED — nothing left at `planned` for the auto-plan pause
    // (MOTIR-1740) to read as a proposal still awaiting review.
    expect((await db.plan.findUnique({ where: { id: planId } }))?.status).toBe('approved');
  });

  it('leaves the CONVERSATION open after an approve — the thread is not consumed', async () => {
    // What makes this a conversation rather than a transaction: approving does
    // not end the thread, so the next turn still refines the same context.
    await openSessionRoute();
    await appendTurnRoute(post('/api/ai/plan-change/session/turns', { body: 'Add a story' }));
    const submitted = await submitRoute();
    const { planId } = (await submitted.json()) as { planId: string };

    await engineProposes(planId, [
      { op: 'add', proposedFields: { title: 'Reporting', kind: 'story' } },
    ]);
    expect((await approvePlan(planId)).status).toBe(200);

    submitJobMock.mockResolvedValue({ jobId: 'job-augment-2' });
    await appendTurnRoute(post('/api/ai/plan-change/session/turns', { body: 'Now split it' }));
    const second = await submitRoute();
    expect(second.status).toBe(200);

    // The refinement still carries the original request. Selected by KIND, not by
    // call index: an approve on a project's first plan also fires the one-shot
    // `propose_convention` job (MOTIR-839), which is a submit this seam does not
    // care about.
    const calls = submitJobMock.mock.calls as unknown as Array<
      [string, unknown, { prompt: string }]
    >;
    const augments = calls.filter((call) => call[0] === 'augment');
    expect(augments).toHaveLength(2);
    const [, , payload] = augments[1]!;
    expect(payload.prompt).toContain('Add a story');
    expect(payload.prompt).toContain('Now split it');
  });

  it('refuses a proposal that would rewrite DONE work, and persists nothing', async () => {
    // The immutability guard sits between the conversation and the tree. It must
    // hold when the proposal arrives from a conversation, not only from the
    // plan-detail surface — and it must be all-or-nothing.
    const shipped = await seedItem({ kind: 'story', title: 'Shipped' });
    for (const status of ['in_progress', 'in_review', 'done'] as const) {
      await workItemsService.updateStatus(shipped.id, status, svcCtx());
    }

    await openSessionRoute();
    await appendTurnRoute(
      post('/api/ai/plan-change/session/turns', { body: 'Redo the shipped work' }),
    );
    const submitted = await submitRoute();
    const { planId } = (await submitted.json()) as { planId: string };

    await engineProposes(planId, [
      { op: 'modify', workItemId: shipped.id, patch: { title: 'Rewritten' } },
      { op: 'add', proposedFields: { title: 'Should not land', kind: 'story' } },
    ]);

    const res = await approvePlan(planId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_TARGET_IMMUTABLE');

    // The DONE item is untouched — the guarantee that actually matters — and the
    // refused plan is still `planned`, so it stays decidable.
    const titles = (await db.workItem.findMany({ where: { projectId: fx.projectId } })).map(
      (r) => r.title,
    );
    expect(titles).toEqual(['Shipped']);
    expect((await db.plan.findUnique({ where: { id: planId } }))?.status).toBe('planned');
  });

  it('does not approve a conversation’s plan without a caller the workspace knows', async () => {
    // The approve resolves against the CALLER's workspace, never the plan's claim
    // about itself. No context → no write, in either tenant.
    await openSessionRoute();
    await appendTurnRoute(post('/api/ai/plan-change/session/turns', { body: 'Add a story' }));
    const submitted = await submitRoute();
    const { planId } = (await submitted.json()) as { planId: string };

    await engineProposes(planId, [
      { op: 'add', proposedFields: { title: 'Leaked', kind: 'story' } },
    ]);

    activeCtx.current = null;
    const res = await approvePlan(planId);
    expect(res.status).toBe(401);

    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
    expect((await db.plan.findUnique({ where: { id: planId } }))?.status).toBe('planned');
  });
});
