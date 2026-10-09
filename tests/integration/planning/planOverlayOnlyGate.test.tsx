// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { db } from '@/lib/db';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { planSessionLaunchContext } from '@/lib/planning/planDestination';
import type { ProjectContext } from '@/lib/projects';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { projectAccessData } from '../../helpers/projectAccess';
import { consentedVisitor } from '../../visitor/_consentedVisitor';

// STORY GATE — A PLAN IS APPROVED ONLY IN THE OVERLAY (Story MOTIR-7883 · MOTIR-7892).
//
// ⚠️ WHAT THIS FILE IS NOT. Each code card pinned its own unit against a STUBBED
// review read: the door (`tests/components/plan-overlay-door.test.tsx`), the
// `/plans/<id>` redirect (`tests/components/plan-page-overlay-redirect.test.tsx`)
// and the rule itself (`tests/planning/planDestination.test.ts`). None of that is
// re-asserted here.
//
// WHAT IS. The assembled seams, against REAL rows:
//
//   1. DOOR → OVERLAY ADDRESS. A `<PlanOverlayDoor planId>` holds only an id. Its
//      client read is routed into the REAL `GET /api/plans/<id>` handler, which reads
//      through `planReviewService` → `planRepository.findManyForGateSummary`. The
//      failure caught is a read that quietly drops `sessionId` / `targetKeys` — or
//      carries ANOTHER plan's — so the door falls back to the bare plan page with its
//      Approve button while every unit test stays green.
//   2. `/plans/<id>` → REDIRECT. `PlanDetailView` driven with the real `getPlanReview`
//      over seeded plans in every class, ENDED sessions included.
//   3. DOOR AND REDIRECT AGREE. For every undecided row, the door composed on `/plans`
//      lands exactly where the redirect sends the same plan.
//
// The stale and ended states are PRODUCED by the shipped services (`planDriftService`,
// `planSessionEndService`), never written as a status: a fixture that invents the
// state proves only that the fixture was written to match the expectation.
//
// Mocked — the boundaries OUTSIDE the path under test, and nothing in it:
//   · the motir-ai client (a Vitest process must not reach it);
//   · `next/navigation` — `redirect` / `notFound` THROW as Next's do, `useRouter` and
//     the host path are spies; `shallowPush` is a spy;
//   · the request scope the route's auth reads: `getSession` (the one mock
//     `CLAUDE.md` sanctions — there is no cookie in a test) and `next/headers`, whose
//     `cookies()` carries the caller's `workspace_id` so the REAL
//     `getWorkspaceContext` → `requireCompliantWorkspaceContext` resolves it;
//   · `next-intl/server`, which needs a request-scoped config the test env has none
//     of (the key is echoed; nothing here asserts copy).

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(),
  getJob: vi.fn(),
}));

// ── The caller's auth, as the request scope would carry it ─────────────────
const auth = vi.hoisted(() => ({
  session: null as { user: { id: string; email: string; name: string } } | null,
  workspaceId: null as string | null,
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => auth.session,
}));
vi.mock('next/headers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/headers')>()),
  cookies: async () => ({
    get: (name: string) =>
      name === 'workspace_id' && auth.workspaceId ? { name, value: auth.workspaceId } : undefined,
    getAll: () => [],
    has: (name: string) => name === 'workspace_id' && auth.workspaceId !== null,
  }),
  headers: async () => new Headers(),
}));

// ── next/navigation: the host path, the router spy, and a THROWING redirect ─
class RedirectSignal extends Error {}
class NotFoundSignal extends Error {}
const nav = vi.hoisted(() => ({
  pathname: '/items/X-1',
  search: '',
  push: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }),
  redirect: (...args: unknown[]) => {
    nav.redirect(...args);
    throw new RedirectSignal('NEXT_REDIRECT');
  },
  notFound: () => {
    nav.notFound();
    throw new NotFoundSignal('NEXT_NOT_FOUND');
  },
  RedirectType: { push: 'push', replace: 'replace' },
}));
const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  getTranslations: async () => (key: string) => key,
}));

const { RedirectType } = await import('next/navigation');
const { GET: planRoute } = await import('@/app/api/plans/[id]/route');
const { default: PlanDetailView } = await import('@/app/(authed)/plans/[id]/_view');
const { PlanOverlayDoor } = await import('@/components/planning/PlanOverlayDoor');
const { plansService } = await import('@/lib/services/plansService');
const { planDriftService } = await import('@/lib/services/planDriftService');
const { planSessionEndService } = await import('@/lib/services/planSessionEndService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { workItemsService } = await import('@/lib/services/workItemsService');

// ── fetch → the REAL `GET /api/plans/<id>` handler ─────────────────────────
const BASE = 'http://localhost:3000';
/** Every response still being produced — `settle` waits for all of them. */
const inFlight = new Set<Promise<unknown>>();
/** Every plan read the route served, as `<id> <status>`. */
const served: string[] = [];
/** Anything fetched that this seam does not serve. Asserted empty. */
const unserved: string[] = [];

function installFetch(): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, BASE);
    const run = async (): Promise<Response> => {
      const plan = /^\/api\/plans\/([^/]+)$/.exec(url.pathname);
      if (plan && (init?.method ?? 'GET') === 'GET') {
        const id = decodeURIComponent(plan[1]!);
        const res = await planRoute(new Request(url, { headers: init?.headers }), {
          params: Promise.resolve({ id }),
        });
        served.push(`${id} ${res.status}`);
        return res;
      }
      unserved.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      return new Response(JSON.stringify({ code: 'NOT_SERVED' }), { status: 404 });
    };
    const p = run();
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p)).catch(() => {});
    return p;
  });
}

/** Drain every route call in flight and every render it causes. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await Promise.allSettled([...inFlight]);
      await new Promise((r) => setTimeout(r, 0));
    });
    if (inFlight.size === 0) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      return;
    }
  }
  throw new Error('route calls never settled');
}

// ── Fixture ────────────────────────────────────────────────────────────────
let caller: V1ProjectCaller;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  vi.clearAllMocks();
  served.length = 0;
  unserved.length = 0;
  nav.pathname = '/items/X-1';
  nav.search = '';
  caller = await createV1ProjectCaller({
    permissions: ['project:browse', 'work_item:edit', 'ai:plan', 'ai:view_plan', 'ai:decide_plan'],
  });
  auth.session = {
    user: { id: caller.fixture.ownerId, email: caller.user.email, name: caller.user.name },
  };
  auth.workspaceId = caller.fixture.workspaceId;
  installFetch();
});

afterEach(async () => {
  cleanup();
  await Promise.allSettled([...inFlight]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = () => caller.ctx;
const fx = () => caller.fixture;
const pctx = (): ProjectContext => ({
  userId: fx().ownerId,
  workspaceId: fx().workspaceId,
  projectId: fx().projectId,
  project: fx().project,
});
const sessionOf = async (planId: string) =>
  (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).sessionId;
const statusOf = async (planId: string) =>
  (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status;

async function card(title: string): Promise<{ id: string; key: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx().projectId, kind: 'story', title },
    ctx(),
  );
  return { id: item.id, key: item.identifier };
}

/**
 * A plan written by the product — session attached by `createPlan` in the same
 * transaction, anchored at `anchorKey` when given, project-wide otherwise. Left
 * `generating` unless `close`d.
 */
async function plan(
  title: string,
  opts: { anchorKey?: string; close?: boolean } = {},
): Promise<string> {
  const created = await plansService.createPlan(
    fx().projectId,
    {
      title,
      session: { origin: 'generation', targetKeys: opts.anchorKey ? [opts.anchorKey] : [] },
    },
    ctx(),
  );
  await plansService.addProposals(
    created.id,
    [{ op: 'add', proposedFields: { title: `${title} — a card`, kind: 'task' } }],
    ctx(),
  );
  if (opts.close) await plansService.markPlanned(created.id, ctx());
  return created.id;
}

/** A plan made STALE through the shipped drift path: its target goes terminal. */
async function stalePlan(anchorKey?: string): Promise<{ planId: string; targetKey: string }> {
  const target = await workItemsService.createWorkItem(
    { projectId: fx().projectId, kind: 'task', title: 'A target that will close' },
    ctx(),
  );
  const created = await plansService.createPlan(
    fx().projectId,
    {
      title: 'stale',
      session: { origin: 'generation', targetKeys: [anchorKey ?? target.identifier] },
    },
    ctx(),
  );
  await plansService.addProposals(
    created.id,
    [{ op: 'modify', workItemId: target.id, patch: { title: 'New' } }],
    ctx(),
  );
  await plansService.markPlanned(created.id, ctx());
  await planDriftService.markStaleForTerminalTarget(target.id, fx().workspaceId, {
    fromStatusKey: 'todo',
    toStatusKey: 'done',
  });
  expect(await statusOf(created.id), 'the drift path made it stale').toBe('stale');
  return { planId: created.id, targetKey: anchorKey ?? target.identifier };
}

/** A `planned` plan whose session was ENDED `restarted` by a person, through the real door. */
async function endedPlannedPlan(
  anchorKey?: string,
): Promise<{ planId: string; sessionId: string }> {
  const planId = await plan('planned, then its session restarted', { anchorKey, close: true });
  const sessionId = (await sessionOf(planId))!;
  const out = await planSessionEndService.endSession(sessionId, 'restarted', {
    workspaceId: fx().workspaceId,
    endedById: fx().ownerId,
    actorId: fx().ownerId,
  });
  expect(out.ended, 'the session really ended').toBe(true);
  const ended = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
  expect(ended.endedAt).not.toBeNull();
  expect(ended.endReason).toBe('restarted');
  expect(await statusOf(planId), 'a restart leaves a planned plan undecided').toBe('planned');
  return { planId, sessionId };
}

/** Render doors under the current host path, let their real reads settle, return each by test id. */
async function renderDoors(planIds: readonly string[]): Promise<HTMLElement[]> {
  render(
    <>
      {planIds.map((id, i) => (
        <PlanOverlayDoor key={id} planId={id} data-testid={`door-${i}`}>
          Review
        </PlanOverlayDoor>
      ))}
    </>,
  );
  await settle();
  // ⚠️ Each door reached the REAL handler and was answered 200 — no stubbed body.
  for (const id of planIds)
    expect(served, `plan ${id} was read by the route`).toContain(`${id} 200`);
  expect(unserved).toEqual([]);
  return planIds.map((_, i) => screen.getByTestId(`door-${i}`));
}

async function doorHref(planId: string, host = '/plans'): Promise<string> {
  const url = new URL(host, BASE);
  nav.pathname = url.pathname;
  nav.search = url.search.replace(/^\?/, '');
  const [door] = await renderDoors([planId]);
  const href = door!.getAttribute('href')!;
  cleanup();
  return href;
}

/** Where the overlay lands for a session, composed by the ONE author. */
function overlay(host: string, sessionId: string, anchorKey: string | null): string {
  return withPlanningOverlay(host, planSessionLaunchContext(sessionId, anchorKey, undefined));
}

/** `/plans/<id>` as a member reaches it. */
const memberPage = () => ({
  actorUserId: fx().ownerId,
  reader: { userId: fx().ownerId, workspaceId: fx().workspaceId },
});

async function view(planId: string, page: object = memberPage()) {
  return PlanDetailView({ ctx: page as never, params: Promise.resolve({ id: planId }) });
}

/** The redirect's target for this plan, asserting it redirected exactly once, as a replace. */
async function redirectTarget(planId: string): Promise<string> {
  nav.redirect.mockClear();
  await expect(view(planId)).rejects.toBeInstanceOf(RedirectSignal);
  expect(nav.redirect).toHaveBeenCalledOnce();
  const [href, type] = nav.redirect.mock.calls[0]!;
  expect(type).toBe(RedirectType.replace);
  return href as string;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. DOOR → OVERLAY ADDRESS
// ════════════════════════════════════════════════════════════════════════════

const HOST = '/items/X-1?tab=activity';

describe('SEAM: a door holding only a plan id lands on its OWN session, through the real read', () => {
  beforeEach(() => {
    nav.pathname = '/items/X-1';
    nav.search = 'tab=activity';
  });

  it('a `planned` plan anchored on a work item → the work-item overlay; a plain click shallowPushes it', async () => {
    const anchor = await card('The card the plan is about');
    const planId = await plan('anchored', { anchorKey: anchor.key, close: true });
    const sessionId = (await sessionOf(planId))!;

    const [door] = await renderDoors([planId]);
    const expected = withPlanningOverlay(HOST, {
      kind: 'work-item',
      itemKey: anchor.key,
      sessionId,
    });
    expect(door!.getAttribute('href')).toBe(expected);

    const event = fireEvent.click(door!, { button: 0 });
    expect(event, 'the click is handled in place').toBe(false);
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(expected);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('a project-wide plan → the project overlay', async () => {
    const planId = await plan('project-wide', { close: true });
    const sessionId = (await sessionOf(planId))!;
    const [door] = await renderDoors([planId]);
    expect(door!.getAttribute('href')).toBe(
      withPlanningOverlay(HOST, { kind: 'project', sessionId }),
    );
  });

  it('a `generating` plan → the overlay', async () => {
    const planId = await plan('still generating');
    expect(await statusOf(planId)).toBe('generating');
    const sessionId = (await sessionOf(planId))!;
    const [door] = await renderDoors([planId]);
    expect(door!.getAttribute('href')).toBe(overlay(HOST, sessionId, null));
    fireEvent.click(door!, { button: 0 });
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(overlay(HOST, sessionId, null));
  });

  it('a `stale` plan (made stale by the real drift service) → the overlay', async () => {
    const { planId, targetKey } = await stalePlan();
    const sessionId = (await sessionOf(planId))!;
    const [door] = await renderDoors([planId]);
    expect(door!.getAttribute('href')).toBe(overlay(HOST, sessionId, targetKey));
    fireEvent.click(door!, { button: 0 });
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(overlay(HOST, sessionId, targetKey));
  });

  it('TWO plans in TWO sessions, two doors on one page → each href carries its OWN session', async () => {
    const anchor = await card('A card for the first plan');
    const first = await plan('the first', { anchorKey: anchor.key, close: true });
    const second = await plan('the second', { close: true });
    const s1 = (await sessionOf(first))!;
    const s2 = (await sessionOf(second))!;
    expect(s1).not.toBe(s2);

    const [a, b] = await renderDoors([first, second]);
    expect(a!.getAttribute('href')).toBe(overlay(HOST, s1, anchor.key));
    expect(b!.getAttribute('href')).toBe(overlay(HOST, s2, null));
    // Neither carries the other's session.
    expect(a!.getAttribute('href')).not.toContain(encodeURIComponent(s2));
    expect(b!.getAttribute('href')).not.toContain(encodeURIComponent(s1));

    fireEvent.click(b!, { button: 0 });
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(overlay(HOST, s2, null));
  });

  it('a `planned` plan whose session was ENDED `restarted` → the overlay at that ended session, and the session read still yields the plan', async () => {
    const anchor = await card('The card the ended session was about');
    const { planId, sessionId } = await endedPlannedPlan(anchor.key);

    const [door] = await renderDoors([planId]);
    const expected = overlay(HOST, sessionId, anchor.key);
    expect(door!.getAttribute('href')).toBe(expected);
    fireEvent.click(door!, { button: 0 });
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(expected);

    // The read the overlay uses to SHOW that plan on the ended session.
    const session = await planChangeSessionsService.getById(pctx(), sessionId);
    expect(session.id).toBe(sessionId);
    expect(session.pendingPlanId, 'the ended session still yields its undecided plan').toBe(planId);
  });

  it('an `approved` plan (approved through the real service) → `/plans/<id>`', async () => {
    const planId = await plan('approved', { close: true });
    await plansService.approvePlan(planId, ctx());
    expect(await statusOf(planId)).toBe('approved');
    const [door] = await renderDoors([planId]);
    expect(door!.getAttribute('href')).toBe(`/plans/${planId}`);
    fireEvent.click(door!, { button: 0 });
    expect(nav.push).toHaveBeenCalledExactlyOnceWith(`/plans/${planId}`);
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('a `declined` plan → `/plans/<id>`', async () => {
    const planId = await plan('declined', { close: true });
    await plansService.declinePlan(planId, ctx());
    expect(await statusOf(planId)).toBe('declined');
    const [door] = await renderDoors([planId]);
    expect(door!.getAttribute('href')).toBe(`/plans/${planId}`);
  });

  it('a hand-seeded NULL session → `/plans/<id>`, and nothing explains it', async () => {
    const planId = await plan('written during the rollout', { close: true });
    // ⚠️ BY HAND, and it has to be: every author path attaches a session, so the
    // rollout residue `prisma/schema.prisma` names has no shipped producer.
    await adminDb.plan.update({ where: { id: planId }, data: { sessionId: null } });

    const [door] = await renderDoors([planId]);
    expect(door!.getAttribute('href')).toBe(`/plans/${planId}`);
    // The retired no-conversation explanation renders nowhere (MOTIR-7885).
    expect(screen.queryByTestId('plan-no-conversation')).toBeNull();
    expect(document.body.textContent).not.toContain('no conversation');
    expect(document.body.textContent).not.toContain('noConversation');
    fireEvent.click(door!, { button: 0 });
    expect(nav.push).toHaveBeenCalledExactlyOnceWith(`/plans/${planId}`);
    expect(shallowPush).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. `/plans/<id>` → REDIRECT
// ════════════════════════════════════════════════════════════════════════════

describe('SEAM: `/plans/<id>` sends a member to the overlay for an undecided plan, over real rows', () => {
  it('`generating`, `planned` and `stale` with an OPEN session → one replace-redirect to the overlay over /plans', async () => {
    const anchor = await card('The anchored card');
    const generating = await plan('generating', { anchorKey: anchor.key });
    const planned = await plan('planned', { close: true });
    const { planId: stale, targetKey } = await stalePlan();

    const cases: Array<[string, string | null]> = [
      [generating, anchor.key],
      [planned, null],
      [stale, targetKey],
    ];
    for (const [planId, anchorKey] of cases) {
      const sessionId = (await sessionOf(planId))!;
      expect(await redirectTarget(planId), `plan ${planId}`).toBe(
        overlay('/plans', sessionId, anchorKey),
      );
    }
  });

  it('the same `planned` plan after its session is ENDED → the same redirect', async () => {
    const anchor = await card('A card');
    const planId = await plan('planned', { anchorKey: anchor.key, close: true });
    const sessionId = (await sessionOf(planId))!;
    const before = await redirectTarget(planId);
    expect(before).toBe(overlay('/plans', sessionId, anchor.key));

    await planSessionEndService.endSession(sessionId, 'restarted', {
      workspaceId: fx().workspaceId,
      endedById: fx().ownerId,
      actorId: fx().ownerId,
    });
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } })).endedAt,
    ).not.toBeNull();
    expect(await statusOf(planId)).toBe('planned');

    expect(await redirectTarget(planId)).toBe(before);
  });

  it('`approved`, `declined` and a NULL session → no redirect; the view renders', async () => {
    const approved = await plan('approved', { close: true });
    await plansService.approvePlan(approved, ctx());
    const declined = await plan('declined', { close: true });
    await plansService.declinePlan(declined, ctx());
    const sessionless = await plan('rollout residue', { close: true });
    await adminDb.plan.update({ where: { id: sessionless }, data: { sessionId: null } });

    for (const planId of [approved, declined, sessionless]) {
      const element = await view(planId);
      expect(isValidElement(element), `plan ${planId} renders`).toBe(true);
    }
    expect(nav.redirect).not.toHaveBeenCalled();
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it('a Visitor on a `planned` plan → no redirect', async () => {
    await adminDb.project.update({
      where: { id: fx().projectId },
      data: projectAccessData('public'),
    });
    const planId = await plan('planned, read by a Visitor', { close: true });
    // A Visitor exists only on a cloud build (`isCloud()`); restored in `afterEach`.
    vi.stubEnv('MOTIR_CLOUD', 'true');
    const reader = await consentedVisitor(caller.projectKey);

    const element = await view(planId, { actorUserId: reader.actorUserId, reader });
    expect(isValidElement(element)).toBe(true);
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it('a plan id that does not exist → `notFound()`, not a redirect', async () => {
    await expect(view('plan_that_does_not_exist')).rejects.toBeInstanceOf(NotFoundSignal);
    expect(nav.notFound).toHaveBeenCalledOnce();
    expect(nav.redirect).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. DOOR AND REDIRECT AGREE
// ════════════════════════════════════════════════════════════════════════════

describe('SEAM: the door composed on /plans equals the redirect, for every undecided row', () => {
  it('open and ended, anchored and project-wide — one landing per plan', async () => {
    const anchor = await card('The anchored card');
    const rows: Array<[string, string]> = [
      ['generating, anchored', await plan('generating', { anchorKey: anchor.key })],
      ['planned, project-wide', await plan('planned', { close: true })],
      ['stale', (await stalePlan()).planId],
      ['planned, ENDED, anchored', (await endedPlannedPlan(anchor.key)).planId],
      ['planned, ENDED, project-wide', (await endedPlannedPlan()).planId],
    ];

    for (const [label, planId] of rows) {
      const fromDoor = await doorHref(planId, '/plans');
      const fromRedirect = await redirectTarget(planId);
      expect(fromDoor, label).toBe(fromRedirect);
      // And it is the overlay on THIS plan's session, not merely the same string.
      const sessionId = (await sessionOf(planId))!;
      expect(new URL(fromDoor, BASE).searchParams.get('planSession'), label).toBe(sessionId);
    }
  });
});
