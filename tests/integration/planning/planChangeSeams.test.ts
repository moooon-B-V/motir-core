import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import {
  parsePlanningLaunch,
  parsePlanningOverlay,
  withPlanningOverlay,
  type PlanningLaunchContext,
} from '@/lib/planning/launcher';
import { workItemCrumbLabel } from '@/lib/planning/projectCanvasModel';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The Story-7.30 INTEGRATION SEAMS (MOTIR-1732) — the joints BETWEEN this
// story's four subtasks, driven with each side's REAL implementation against a
// real Postgres. Every subtask ships its own units (MOTIR-1728/1729/1730/1731);
// what no unit can see is KEY DRIFT across a boundary, because each side's units
// assert against their own fixture of the other side's shape.
//
// The three joints, in the order a user crosses them:
//
//   1. LAUNCHER → READER. The launcher writes a query; something reads it back.
//      The pure round trip is unit-tested; what is NOT is that the real readers
//      actually parse what the real writer emits. Since MOTIR-4732 there are two
//      of them — the OVERLAY, client-side, and the `/planning` FORWARD,
//      server-side — and both are driven below.
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
// ⚠️ RE-POINTED (MOTIR-4732). This used to import `app/(planning)/planning/page`
// and drive the route's Server Component. That route is DELETED — the workspace
// is an overlay (MOTIR-4729) — so the two joints it tested moved:
//
//   · what the launcher WRITES and a server READS is now the `/planning`
//     FORWARD, the one surviving reader of the route-era query and what an old
//     bookmark lands on;
//   · what turns an anchor into the canvas's ARRIVAL LEVEL is now
//     `GET /api/work-items/planning-anchor` (MOTIR-4727), which the overlay
//     fetches because a client island may not reach a service.
//
// Both are driven below against the same real, really-nested project. What is
// GONE with the page is its own gate arms (sign-in, no-project, the onboarding
// forward) — those now run in the overlay off `resolvePlanningHostGate`, a pure
// function with its own coverage, and the page that composed them no longer
// exists to be tested.
const { planningForwardTarget, default: PlanningForwardPage } =
  await import('@/app/(authed)/planning/page');
const { GET: anchorRoute } = await import('@/app/api/work-items/planning-anchor/route');
// The SHIPPED approve client — what the close-with-pending guard's *Confirm &
// add* reaches through `usePlanChangeConversation.approve` (MOTIR-4731).
const { approvePlanRequest } = await import('@/lib/planning/planReviewClient');

const BASE = 'http://localhost:3000';

function post(path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The OVERLAY address a door writes for `context`, on `page` — through the
 *  SHIPPED merge, so a host page that already has a query is handled the way a
 *  real door handles it rather than by string concatenation here. */
function overlayAddress(context: PlanningLaunchContext, page = '/backlog'): string {
  return withPlanningOverlay(page, context);
}

/** The launch the OVERLAY reads back off that address. */
function launchFromOverlay(context: PlanningLaunchContext) {
  return parsePlanningOverlay(new URL(overlayAddress(context), BASE).searchParams);
}

/** The ROUTE-era address an old bookmark still carries. */
function legacySearchParams(context: PlanningLaunchContext): Record<string, string> {
  const params = new URLSearchParams({
    mode:
      context.kind === 'work-item'
        ? context.hasPlan
          ? 'replan'
          : 'contextual'
        : context.kind === 'roadmap'
          ? 'roadmap'
          : context.kind === 'convention-refine'
            ? 'contextual'
            : context.hasPlan === undefined
              ? 'project'
              : context.hasPlan
                ? 'replan'
                : 'generation',
    from: context.kind,
  });
  if (context.kind === 'work-item') params.set('item', context.itemKey);
  if (context.kind === 'convention-refine') params.set('repo', context.repoKey);
  return Object.fromEntries(params.entries());
}

/** Drive the real anchor ROUTE — what the overlay fetches for a work-item launch. */
async function readAnchor(itemKey: string) {
  const res = await anchorRoute(
    new Request(`${BASE}/api/work-items/planning-anchor?key=${encodeURIComponent(itemKey)}`),
  );
  if (res.status !== 200) return null;
  return (await res.json()) as {
    anchor: { id: string; identifier: string; title: string; kind: string };
    ancestors: { id: string; identifier: string; title: string }[];
  };
}

/** The canvas's arrival trail, composed exactly as the overlay composes it. */
function trailFrom(found: Awaited<ReturnType<typeof readAnchor>>) {
  return (found?.ancestors ?? []).map((a) => ({
    id: a.id,
    label: workItemCrumbLabel(a.identifier, a.title),
  }));
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
  await adminDb.$disconnect();
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
  await adminDb.project.update({ where: { id: fx.projectId }, data: { onboardingRanAt } });
  // The context the page reads carries the DTO form (an ISO string), so patch
  // the marker on the DTO rather than swapping in the raw Prisma row.
  activeCtx.current = {
    ...activeCtx.current!,
    project: { ...activeCtx.current!.project, onboardingRanAt: onboardingRanAt.toISOString() },
  };
}

// ──────────────── Seam 1 — the launcher → what a SERVER reads ────────────────
//
// ⚠️ RE-POINTED (MOTIR-4732). This joint used to be *the launcher writes a
// query, the `/planning` route reads it back into the host's props*. The route
// is deleted; the property is not. What a launcher writes is now read in two
// places, and both are driven here against the real modules:
//
//   · the OVERLAY, client-side, off `parsePlanningOverlay`;
//   · the `/planning` FORWARD, server-side, off `parsePlanningLaunch` — the one
//     surviving reader of the route-era names, and what an old bookmark lands on.
//
// The page's own gate arms (sign-in, no-project, the onboarding forward) went
// with the page: they are `resolvePlanningHostGate`'s now, which the overlay
// calls and which has its own coverage.

describe('seam · the launcher’s OVERLAY address is what the overlay resolves', () => {
  it('carries a project launch’s mode + origin across the write/read boundary', async () => {
    await markOnboarded();

    expect(launchFromOverlay({ kind: 'project', hasPlan: true })).toEqual({
      mode: 'replan',
      from: 'project',
      itemKey: null,
      repoKey: null,
    });
  });

  it('carries a work-item launch’s target key', async () => {
    await markOnboarded();

    expect(launchFromOverlay({ kind: 'work-item', itemKey: 'PROD-7' })).toEqual({
      mode: 'contextual',
      from: 'work-item',
      itemKey: 'PROD-7',
      repoKey: null,
    });
  });

  it('carries a convention-refine launch’s repo key', async () => {
    await markOnboarded();

    expect(launchFromOverlay({ kind: 'convention-refine', repoKey: 'moooon/motir-core' })).toEqual({
      mode: 'contextual',
      from: 'convention-refine',
      itemKey: null,
      repoKey: 'moooon/motir-core',
    });
  });

  it('leaves the HOST page’s own query untouched — the reason the names are namespaced', async () => {
    await markOnboarded();

    // A door on the drilled roadmap. The workspace opens; the level does not move.
    const address = overlayAddress({ kind: 'roadmap' }, '/roadmap?item=PROD-12');
    const url = new URL(address, BASE);
    expect(url.searchParams.get('item')).toBe('PROD-12');
    expect(parsePlanningOverlay(url.searchParams)?.from).toBe('roadmap');
  });
});

describe('seam · an OLD /planning link still lands in the workspace (the forward)', () => {
  // The migration's client for stragglers: a bookmark, a chat message, a stale
  // tab. Driven through the real forward module over the real launcher's parse.

  it('sends a work-item launch to that item’s page, workspace open over it', async () => {
    await markOnboarded();

    const target = planningForwardTarget(
      legacySearchParams({ kind: 'work-item', itemKey: 'PROD-7' }),
    );
    const url = new URL(target, BASE);

    expect(url.pathname).toBe('/items/PROD-7');
    expect(parsePlanningOverlay(url.searchParams)).toEqual({
      mode: 'contextual',
      from: 'work-item',
      itemKey: 'PROD-7',
      repoKey: null,
    });
  });

  it('sends a convention-refine launch to code health', async () => {
    await markOnboarded();

    const url = new URL(
      planningForwardTarget(legacySearchParams({ kind: 'convention-refine', repoKey: 'r' })),
      BASE,
    );
    expect(url.pathname).toBe('/code-health');
    expect(parsePlanningOverlay(url.searchParams)?.repoKey).toBe('r');
  });

  it('sends everything else to the roadmap, including a bare /planning', async () => {
    await markOnboarded();

    expect(new URL(planningForwardTarget({}), BASE).pathname).toBe('/roadmap');
    const replan = new URL(
      planningForwardTarget(legacySearchParams({ kind: 'project', hasPlan: true })),
      BASE,
    );
    expect(replan.pathname).toBe('/roadmap');
    expect(parsePlanningOverlay(replan.searchParams)?.mode).toBe('replan');
  });

  it('the PAGE really redirects — not just the mapping it is built from', async () => {
    // `planningForwardTarget` is the pure half and every case above drives it.
    // This drives the SERVER COMPONENT: `redirect()` throws in Next, and the
    // suite's `TestRedirect` makes the throw inspectable, so what is asserted is
    // that the page hands that exact address to the framework.
    await markOnboarded();

    await expect(
      PlanningForwardPage({
        searchParams: Promise.resolve({ mode: 'contextual', from: 'work-item', item: 'PROD-7' }),
      }),
    ).rejects.toMatchObject({
      to: planningForwardTarget({ mode: 'contextual', from: 'work-item', item: 'PROD-7' }),
    });

    // …and a bare `/planning`, the shape a stale bookmark most often has.
    await expect(PlanningForwardPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
      TestRedirect,
    );
  });

  it('does not smuggle a target a hand-edited old address did not own', async () => {
    // The anti-smuggling rule survives the migration in both directions: the
    // legacy parse drops it, and the overlay writer never emits it.
    const url = new URL(
      planningForwardTarget({ mode: 'roadmap', from: 'roadmap', item: 'PROD-1' }),
      BASE,
    );
    expect(parsePlanningOverlay(url.searchParams)?.itemKey).toBeNull();
  });

  it('parses the launch through the SHIPPED module, not a copy of the names', async () => {
    // The forward is the last reader of `mode` / `from` / `item` / `repo`. If the
    // legacy parse ever moved, this is what notices.
    expect(parsePlanningLaunch({ mode: 'replan', from: 'work-item', item: 'PROD-3' })).toEqual({
      mode: 'replan',
      from: 'work-item',
      itemKey: 'PROD-3',
      repoKey: null,
    });
  });
});

// ───────── Seam 1b — the anchor → the CANVAS's arrival level ─────────
//
// The `?item=` anchor used to reach only the CONVERSATION: the workspace opened
// on the project's epics and drew that subtask's target ring on a level the user
// was not on (MOTIR-2070). What no unit can see is whether the trail is ACTUALLY
// derived from the real tree — a unit test asserts against its own fixture of the
// ancestor chain.
//
// ⚠️ RE-POINTED (MOTIR-4732). The page that made this read on the server is
// deleted; the overlay is a client island, so the read crosses HTTP now
// (`GET /api/work-items/planning-anchor`, MOTIR-4727). Same real, really-nested
// project, same assertions — one layer over.

describe('seam · a work-item launch opens the canvas ON the anchor’s level', () => {
  it('derives the trail from the REAL ancestor chain, root→parent, anchor excluded', async () => {
    await markOnboarded();
    const epic = await seedItem({ kind: 'epic', title: 'Epic 7: AI Planning Layer' });
    const story = await seedItem({
      kind: 'story',
      title: 'Contextual planning from each work item',
      parentId: epic.id,
    });
    const subtask = await seedItem({
      kind: 'subtask',
      title: 'Seed the canvas at the anchor',
      parentId: story.id,
    });

    const found = await readAnchor(subtask.identifier);

    // The canvas opens on the level CONTAINING the anchor: the last crumb is the
    // anchor's PARENT, so the anchor itself is one of the nodes drawn — with its
    // siblings and dependency edges, the context a plan-change turn about it needs.
    expect(trailFrom(found)).toEqual([
      { id: epic.id, label: `${epic.identifier} · Epic 7: AI Planning Layer` },
      { id: story.id, label: `${story.identifier} · Contextual planning from each work item` },
    ]);
    // …and the anchor still reaches the conversation + the target set, unchanged.
    expect(found?.anchor.id).toBe(subtask.id);
    expect(found?.anchor.identifier).toBe(subtask.identifier);
  });

  it('leaves a ROOT-level anchor (an epic) at the root — it is already on that level', async () => {
    await markOnboarded();
    const epic = await seedItem({ kind: 'epic', title: 'Billing' });

    const found = await readAnchor(epic.identifier);

    expect(trailFrom(found)).toEqual([]);
    expect(found?.anchor.id).toBe(epic.id);
  });

  it('falls back to the ROOT level for an unresolvable key, with no error state', async () => {
    await markOnboarded();
    await seedItem({ kind: 'epic', title: 'Billing' });

    // A hand-edited / another tenant's / deleted key: the route answers the
    // no-existence-leak 404 and the client turns it into `null`. The workspace
    // must still open — on the project conversation at the root level.
    const found = await readAnchor('PROD-9999');

    expect(found).toBeNull();
    expect(trailFrom(found)).toEqual([]);
  });

  it('a STORY anchor opens on its own level — one crumb, the epic above it', async () => {
    // The middle of the three shapes, and the one a fixture test would most
    // easily get wrong: not the leaf, not the root.
    await markOnboarded();
    const epic = await seedItem({ kind: 'epic', title: 'Epic 7: AI Planning Layer' });
    const story = await seedItem({ kind: 'story', title: 'The overlay', parentId: epic.id });
    await seedItem({ kind: 'subtask', title: 'A child nobody asked for', parentId: story.id });

    const found = await readAnchor(story.identifier);

    // ANCESTORS ONLY: the story's own children are NOT the level — opening
    // inside it would hide the item the conversation is about (MOTIR-2070).
    expect(trailFrom(found)).toEqual([
      { id: epic.id, label: `${epic.identifier} · Epic 7: AI Planning Layer` },
    ]);
    expect(found?.anchor.id).toBe(story.id);
    expect(found?.anchor.kind).toBe('story');
  });

  it('reads against the ACTIVE project only — another tenant’s row is never reachable', async () => {
    // The no-existence-leak contract at this layer. `tests/api/planning-anchor-route.test.ts`
    // asserts the byte-identical 404 for a forbidden key and an unknown one, on
    // two scenarios built for it; what THIS seam adds is that the route resolves
    // the key against the caller's ACTIVE project — so a second tenant holding
    // the same identifier gets its own row, never the stranger's.
    await markOnboarded();
    const mine = await seedItem({ kind: 'epic', title: 'Mine' });

    const stranger = await makeWorkItemFixture();
    const theirs = await workItemsService.createWorkItem(
      { projectId: stranger.projectId, kind: 'epic', title: 'Theirs' },
      { userId: stranger.ownerId, workspaceId: stranger.workspaceId },
    );

    const found = await readAnchor(theirs.identifier);
    // Same identifier string, different tenant: what comes back is MINE, and the
    // stranger's title never crosses.
    expect(found?.anchor.id).not.toBe(theirs.id);
    if (found) expect(found.anchor.title).not.toBe('Theirs');

    // …and a key no project owns is the ordinary 404.
    const unknown = await anchorRoute(
      new Request(`${BASE}/api/work-items/planning-anchor?key=${fx.project.identifier}-99999`),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      code: 'NOT_FOUND',
      error: 'Work item not available.',
    });

    // The control: a key the actor MAY see still answers.
    expect((await readAnchor(mine.identifier))?.anchor.id).toBe(mine.id);
  });

  it('a project-scoped launch carries no anchor to read at all', async () => {
    await markOnboarded();
    await seedItem({ kind: 'epic', title: 'Billing' });

    // The overlay only reads for a `work-item` origin — the address is what says
    // so, and the anti-smuggling rule is what makes that trustworthy.
    expect(launchFromOverlay({ kind: 'project', hasPlan: true })?.itemKey).toBeNull();
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
    expect(kind).toBe('plan');
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

  it('the GUARD’s *Confirm & add* reaches materialize through the SHIPPED client', async () => {
    // ⚠️ THE LAST LINK OF THE CLOSE-WITH-PENDING SEAM (MOTIR-4731 / MOTIR-4733).
    // `tests/components/plan-close-guard.test.tsx` proves the guard's *Confirm &
    // add* calls the host's `approve` and closes only on the success callback —
    // with a stubbed conversation, because a happy-dom render cannot drive a
    // database. THIS is the other half: `approve` calls `approvePlanRequest`
    // (`lib/hooks/usePlanChangeConversation.ts:1075`), the SHIPPED client, and
    // that client is driven here against the REAL route over real Postgres. So
    // the chain is covered end to end without either half faking the other.
    const epic = await seedItem({ kind: 'epic', title: 'Billing' });

    await openSessionRoute();
    await appendTurnRoute(post('/api/ai/plan-change/session/turns', { body: 'Add auth' }));
    const submitted = await submitRoute();
    const { planId } = (await submitted.json()) as { planId: string };

    await engineProposes(planId, [
      {
        op: 'add',
        proposedFields: { title: 'Auth for billing', kind: 'story' },
        parentRef: epic.id,
      },
    ]);

    // The client builds the request the guard's Confirm produces; `fetch` is
    // routed to the real handler because a Vitest process has no server. Nothing
    // about the REQUEST is restated here — the client owns its method, its path
    // and its headers, which is the drift this seam exists to catch.
    const seen: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, method: init?.method });
      const id = url.split('/api/plans/')[1]!.split('/')[0]!;
      return approvePlanRoute(new Request(`${BASE}${url}`, { method: init?.method ?? 'GET' }), {
        params: Promise.resolve({ id: decodeURIComponent(id) }),
      });
    });

    try {
      const approved = await approvePlanRequest(planId);
      expect(approved.id).toBe(planId);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(seen).toEqual([{ url: `/api/plans/${planId}/approve`, method: 'POST' }]);

    // …and the proposal became a real row under the real parent. A guard that
    // closed on anything less would be closing on a promise.
    const children = await adminDb.workItem.findMany({ where: { parentId: epic.id } });
    expect(children.map((c) => c.title)).toContain('Auth for billing');
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
    const opened = await adminDb.plan.findUnique({ where: { id: planId } });
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
    const rows = await adminDb.workItem.findMany({
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
    expect((await adminDb.plan.findUnique({ where: { id: planId } }))?.status).toBe('approved');
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
    // care about. Since MOTIR-4304 the kind that selects the planning submits is
    // `plan` — the ONE planning kind — and `propose_convention` is still the
    // thing being filtered out, so the selection is unchanged in what it means.
    const calls = submitJobMock.mock.calls as unknown as Array<
      [string, unknown, { prompt: string }]
    >;
    const planningSubmits = calls.filter((call) => call[0] === 'plan');
    expect(planningSubmits).toHaveLength(2);
    const [, , payload] = planningSubmits[1]!;
    expect(payload.prompt).toContain('Add a story');
    expect(payload.prompt).toContain('Now split it');
  });

  it('refuses a proposal that would rewrite DONE work, and persists nothing', async () => {
    // The immutability guard sits between the conversation and the tree. It must
    // hold when the proposal arrives from a conversation, not only from the
    // plan-detail surface — and it must be all-or-nothing.
    const shipped = await seedItem({ kind: 'story', title: 'Shipped' });

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
    // The target SHIPS while the plan waits — the drift the approve gate exists
    // for, and since MOTIR-3573 the only way a terminal target reaches approve
    // at all: a plan whose target is already terminal is refused at the CLOSE.
    for (const status of ['in_progress', 'in_review', 'done'] as const) {
      await workItemsService.updateStatus(shipped.id, status, svcCtx());
    }

    const res = await approvePlan(planId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_TARGET_IMMUTABLE');

    // The DONE item is untouched — the guarantee that actually matters — and the
    // refused plan is still DECIDABLE, which is what "stays in the queue" means.
    const titles = (await adminDb.workItem.findMany({ where: { projectId: fx.projectId } })).map(
      (r) => r.title,
    );
    expect(titles).toEqual(['Shipped']);
    // ⚠️ `stale`, NOT `planned` (MOTIR-3579). The plan's target finished while it
    // waited, so it can no longer be approved and stops claiming it can —
    // `agent-authored-plans.md` AMENDMENT 9 D1/D5. It is still live and still
    // declinable; what it is not is a plan wearing a button that cannot work.
    expect((await adminDb.plan.findUnique({ where: { id: planId } }))?.status).toBe('stale');
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

    const workItemCount = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    expect(workItemCount).toBe(0);
    expect((await adminDb.plan.findUnique({ where: { id: planId } }))?.status).toBe('planned');
  });
});
