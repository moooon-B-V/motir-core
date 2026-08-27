// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, findFirst, renderTree, until } from '../../helpers/serverPageHarness';

// FAMILY 3 of 5 — CANVASES (Story MOTIR-3440 · Task MOTIR-3568).
//
// `/plans/[id]` is the canvas family's one real diff: MOTIR-3445 collapsed its
// project resolution and its establish-view read into ONE WAVE, and left the
// other three canvases alone with that verdict recorded.
//
// ⚠️ THIS IS WHERE THE HARNESS EARNS ITS KEEP AGAINST A STRUCTURAL TEST.
// `tests/navigation/canvas-surfaces-arrival.test.ts` asserts the wave by finding
// a `Promise.all([...])` whose TEXT contains both call names. That is a claim
// about the source, and it survives every edit that keeps the two names inside
// one `Promise.all` while making them serial in fact — an `await` moved into the
// first arm, a second `await` on a value the first returns. Here the claim is
// about EXECUTION: hold both reads open and assert that both were ISSUED, which
// no rewriting of the source can fake.
//
// No Fizz render: this page has no boundary and its body is `PlanDetail`, a
// large client island whose markup is nothing this card decides. `renderTree`
// runs every line of the page and stops at the island's element.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { getWorkspaceContext } = vi.hoisted(() => ({ getWorkspaceContext: vi.fn() }));
const { getPlanReview } = vi.hoisted(() => ({ getPlanReview: vi.fn() }));
const { assertProjectInWorkspace } = vi.hoisted(() => ({ assertProjectInWorkspace: vi.fn() }));
const { getEstablishView } = vi.hoisted(() => ({ getEstablishView: vi.fn() }));
const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

vi.mock('next/navigation', async () => ({
  ...(await import('../../helpers/serverPageHarness')).navigationHooks(),
  redirect,
  notFound,
}));
vi.mock('next-intl/server', async () => ({
  getTranslations: (await import('../../helpers/serverPageHarness')).serverTranslations,
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/workspaces', () => ({ getWorkspaceContext }));
vi.mock('@/lib/services/planReviewService', () => ({
  planReviewService: { getPlanReview },
}));
vi.mock('@/lib/services/projectsService', () => ({
  projectsService: { assertProjectInWorkspace },
}));
vi.mock('@/lib/services/projectRepoEstablishService', () => ({
  projectRepoEstablishService: { getEstablishView },
}));

import PlanDetailPage from '@/app/(authed)/plans/[id]/page';
import { PlanDetail } from '@/components/planning/PlanDetail';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

const CTX = { userId: 'u1', workspaceId: 'ws1' };
const params = (id = 'plan_1') => ({ params: Promise.resolve({ id }) });

const review = (status: string) => ({
  id: 'plan_1',
  title: 'A plan',
  projectId: 'p1',
  status,
});

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getWorkspaceContext.mockResolvedValue(CTX);
  getPlanReview.mockResolvedValue(review('planned'));
  assertProjectInWorkspace.mockResolvedValue({ identifier: 'ACME' });
  getEstablishView.mockResolvedValue({ set: { rows: [] } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('/plans/[id] — the two follow-on reads are ONE WAVE, in execution', () => {
  it('issues the establish-view read while the project resolution is still open', async () => {
    getPlanReview.mockResolvedValue(review('approved'));
    const project = deferred<{ identifier: string }>();
    assertProjectInWorkspace.mockReturnValue(project.promise);

    const rendered = renderTree(PlanDetailPage, params());
    // Wait until the FIRST arm has been issued and is unsettled. If the two were
    // serial, the second could not have been reached at this moment — which is
    // the whole assertion, and it is about execution rather than source text.
    await until(() => assertProjectInWorkspace.mock.calls.length > 0, {
      label: 'the project resolution to be issued',
    });

    expect(getEstablishView).toHaveBeenCalledTimes(1);

    project.resolve({ identifier: 'ACME' });
    const tree = await rendered;
    expect(findFirst(tree, PlanDetail)).toBeDefined();
  });

  it('issues NO establish-view read for a plan that is not approved', async () => {
    // The conditional stays conditional (MOTIR-3445's own ⚠️): a `planned` plan
    // has nothing to establish, and asking would be a GitHub round trip on every
    // page view.
    const tree = await renderTree(PlanDetailPage, params());

    expect(assertProjectInWorkspace).toHaveBeenCalledTimes(1);
    expect(getEstablishView).not.toHaveBeenCalled();
    expect(findFirst(tree, PlanDetail)!.props['repositorySet']).toBeNull();
  });
});

describe('/plans/[id] — the degradations, each of which keeps the page up', () => {
  it('renders the canvas with an empty project key when the project resolution fails', async () => {
    // Each read keeps its OWN catch, deliberately: a bare `Promise.all` would
    // let one rejection discard the other's result.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    assertProjectInWorkspace.mockRejectedValue(new Error('boom'));

    const tree = await renderTree(PlanDetailPage, params());

    expect(findFirst(tree, PlanDetail)!.props['projectKey']).toBe('');
  });

  it('renders the canvas with no repository set when the establish read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getPlanReview.mockResolvedValue(review('approved'));
    getEstablishView.mockRejectedValue(new Error('github down'));

    const tree = await renderTree(PlanDetailPage, params());

    expect(findFirst(tree, PlanDetail)!.props['repositorySet']).toBeNull();
  });

  it('hides a missing plan as a 404, with no existence leak', async () => {
    getPlanReview.mockRejectedValue(new PlanNotFoundError('plan_1'));

    await expect(renderTree(PlanDetailPage, params())).rejects.toThrow('NOT_FOUND');
  });

  it('hides a plan in an unbrowsable project as the same 404', async () => {
    getPlanReview.mockRejectedValue(new ProjectAccessDeniedError('p1', 'browse'));

    await expect(renderTree(PlanDetailPage, params())).rejects.toThrow('NOT_FOUND');
  });

  it('rethrows anything that is neither', async () => {
    getPlanReview.mockRejectedValue(new Error('a real failure'));

    await expect(renderTree(PlanDetailPage, params())).rejects.toThrow('a real failure');
  });

  it('bounces a signed-out reader before it reads the plan', async () => {
    getSession.mockResolvedValue(null);

    await expect(renderTree(PlanDetailPage, params())).rejects.toThrow('REDIRECT:/sign-in');
    expect(getPlanReview).not.toHaveBeenCalled();
  });

  it('404s when there is no workspace context', async () => {
    getWorkspaceContext.mockResolvedValue(null);

    await expect(renderTree(PlanDetailPage, params())).rejects.toThrow('NOT_FOUND');
    expect(getPlanReview).not.toHaveBeenCalled();
  });
});
