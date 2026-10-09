import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement } from 'react';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// `/plans/<id>` SENDS A MEMBER TO THE OVERLAY FOR AN UNDECIDED PLAN (Story MOTIR-7883 ·
// MOTIR-7888). The view is called as the server component it is, with the review read
// stubbed and `redirect` throwing the way Next's does. What is pinned: an undecided plan
// with a session replace-redirects to `/plans` with the overlay on that session — open
// or ended, the view never reads the end — and a decided plan, a session-less plan and
// a Visitor fall through to the page, while a redirected request spends nothing on the
// member-only reads.

class RedirectSignal extends Error {}

const mocks = vi.hoisted(() => ({
  getPlanReview: vi.fn(),
  assertProjectInWorkspace: vi.fn(),
  getEstablishView: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => {
    mocks.redirect(...args);
    throw new RedirectSignal('NEXT_REDIRECT');
  },
  notFound: () => {
    mocks.notFound();
    throw new Error('NEXT_NOT_FOUND');
  },
  RedirectType: { push: 'push', replace: 'replace' },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/services/planReviewService', () => ({
  planReviewService: { getPlanReview: mocks.getPlanReview },
}));
vi.mock('@/lib/services/projectsService', () => ({
  projectsService: { assertProjectInWorkspace: mocks.assertProjectInWorkspace },
}));
vi.mock('@/lib/services/projectRepoEstablishService', () => ({
  projectRepoEstablishService: { getEstablishView: mocks.getEstablishView },
}));
vi.mock('@/components/planning/PlanDetail', () => ({ PlanDetail: () => null }));

const { default: PlanDetailView } = await import('@/app/(authed)/plans/[id]/_view');
const { PlanNotFoundError } = await import('@/lib/plans/errors');

const MEMBER = { actorUserId: 'u1', reader: { userId: 'u1', workspaceId: 'w1' } };
const VISITOR = {
  actorUserId: null,
  reader: { kind: 'visitor', project: { id: 'p1', identifier: 'ACME' } },
};

function review(
  status: PlanReviewDto['status'],
  conversation: { sessionId: string; targetKeys: string[] } | null,
): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'p1',
    status,
    title: 'A plan',
    conversation: conversation && { ...conversation, hasTurns: true },
  } as unknown as PlanReviewDto;
}

async function view(ctx: object = MEMBER) {
  return PlanDetailView({
    ctx: ctx as never,
    params: Promise.resolve({ id: 'plan_1' }),
  });
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertProjectInWorkspace.mockResolvedValue({ identifier: 'ACME' });
  mocks.getEstablishView.mockResolvedValue(null);
});

describe('an UNDECIDED plan with a session → the overlay over /plans, as a replace', () => {
  it.each(['generating', 'planned', 'stale'] as const)(
    '%s, anchored → the work-item context',
    async (status) => {
      mocks.getPlanReview.mockResolvedValue(
        review(status, { sessionId: 's1', targetKeys: ['MOTIR-12'] }),
      );
      await expect(view()).rejects.toBeInstanceOf(RedirectSignal);
      expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(
        withPlanningOverlay('/plans', { kind: 'work-item', itemKey: 'MOTIR-12', sessionId: 's1' }),
        'replace',
      );
      // Redirected before the member-only reads.
      expect(mocks.assertProjectInWorkspace).not.toHaveBeenCalled();
      expect(mocks.getEstablishView).not.toHaveBeenCalled();
    },
  );

  it('project-wide when the session has no anchor', async () => {
    mocks.getPlanReview.mockResolvedValue(review('planned', { sessionId: 's1', targetKeys: [] }));
    await expect(view()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(
      withPlanningOverlay('/plans', { kind: 'project', sessionId: 's1' }),
      'replace',
    );
  });
});

describe('everything else renders the plan page', () => {
  it.each([
    ['approved', { sessionId: 's1', targetKeys: ['MOTIR-12'] }],
    ['declined', { sessionId: 's1', targetKeys: [] }],
    ['planned', null],
  ] as const)('%s (session %j) renders, no redirect', async (status, conversation) => {
    mocks.getPlanReview.mockResolvedValue(review(status, conversation));
    const element = await view();
    expect(isValidElement(element)).toBe(true);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.assertProjectInWorkspace).toHaveBeenCalledOnce();
  });

  it('a Visitor on an undecided plan is not redirected', async () => {
    mocks.getPlanReview.mockResolvedValue(review('planned', { sessionId: 's1', targetKeys: [] }));
    const element = await view(VISITOR);
    expect(isValidElement(element)).toBe(true);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('a missing plan is still a 404, not a redirect', async () => {
    mocks.getPlanReview.mockRejectedValue(new PlanNotFoundError('plan_1'));
    await expect(view()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
