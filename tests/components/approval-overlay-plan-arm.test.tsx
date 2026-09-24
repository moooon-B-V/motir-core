// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// THE APPROVAL OVERLAY'S ONE PLAN ARM (Story MOTIR-6012 · MOTIR-6037; ADR
// `approval-gates.md` §11.5b; design `design/ai-planning/design-notes.md` Part XX §20.2).
// A plan gate is never decided in the overlay and renders no port. Nothing writes
// `?approval=` for it, so an address that hands the overlay one is a stale or
// hand-typed link — and the overlay SENDS the reader on: to the planning surface at the
// plan's conversation, or to the plan's own page when it has none. Never an empty frame.

let params = new URLSearchParams();
const { push, replace, refresh } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh }),
  usePathname: () => '/workbench',
  useSearchParams: () => params,
}));
const { shallowPush, shallowReplace } = vi.hoisted(() => ({
  shallowPush: vi.fn(),
  shallowReplace: vi.fn(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace }));
const { fetchApprovalGateOverlay } = vi.hoisted(() => ({ fetchApprovalGateOverlay: vi.fn() }));
vi.mock('@/lib/approvals/approvalOverlayClient', () => ({ fetchApprovalGateOverlay }));
const { fetchPlanReview } = vi.hoisted(() => ({ fetchPlanReview: vi.fn() }));
vi.mock('@/lib/planning/planReviewClient', () => ({ fetchPlanReview }));

const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');

function reviewWith(conversation: PlanReviewDto['conversation']): PlanReviewDto {
  return { id: 'plan-9', conversation } as PlanReviewDto;
}

async function openPlanGate(planId = 'plan-9') {
  params = new URLSearchParams(`tab=approvals&approval=${planId}&approvalKind=plan_approval`);
  const view = render(<ApprovalOverlay />);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  for (const fn of [push, replace, refresh, shallowPush, shallowReplace]) fn.mockReset();
  fetchApprovalGateOverlay.mockReset();
  fetchPlanReview.mockReset();
});
afterEach(cleanup);

describe('handing the approval overlay a PLAN gate', () => {
  it('renders no frame, never reads the gate overlay, and sends a TARGETED plan to the planning surface', async () => {
    fetchPlanReview.mockResolvedValue(
      reviewWith({ sessionId: 's-9', hasTurns: true, targetKeys: ['ACME-12', 'ACME-31'] }),
    );
    await openPlanGate();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchApprovalGateOverlay).not.toHaveBeenCalled();
    expect(fetchPlanReview).toHaveBeenCalledWith('plan-9', expect.anything());
    expect(shallowReplace).toHaveBeenCalledTimes(1);
    const href = new URL(shallowReplace.mock.calls[0]![0] as string, 'http://x');
    expect(href.pathname).toBe('/workbench');
    expect(href.searchParams.get('tab')).toBe('approvals');
    expect(href.searchParams.has('approval')).toBe(false);
    expect(href.searchParams.has('approvalKind')).toBe(false);
    expect(href.searchParams.get('plan')).toBe('contextual');
    expect(href.searchParams.get('planFrom')).toBe('work-item');
    expect(href.searchParams.get('planItem')).toBe('ACME-12');
    expect(href.searchParams.get('planSession')).toBe('s-9');
    expect(href.searchParams.get('planVia')).toBe('approvals');
    expect(replace).not.toHaveBeenCalled();
  });

  it('an untargeted plan opens the project conversation', async () => {
    fetchPlanReview.mockResolvedValue(
      reviewWith({ sessionId: 's-9', hasTurns: true, targetKeys: [] }),
    );
    await openPlanGate();
    const href = new URL(shallowReplace.mock.calls[0]![0] as string, 'http://x');
    expect(href.searchParams.get('plan')).toBe('project');
    expect(href.searchParams.get('planFrom')).toBe('project');
    expect(href.searchParams.has('planItem')).toBe(false);
    expect(href.searchParams.get('planVia')).toBe('approvals');
  });

  it.each([
    ['no conversation', null],
    ['a conversation with no turns', { sessionId: 's-9', hasTurns: false, targetKeys: [] }],
  ])('%s → the plan’s own page', async (_label, conversation) => {
    fetchPlanReview.mockResolvedValue(reviewWith(conversation));
    await openPlanGate();
    expect(replace).toHaveBeenCalledWith('/plans/plan-9');
    expect(shallowReplace).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a failed read still lands somewhere — the plan page, never an empty frame', async () => {
    fetchPlanReview.mockRejectedValue(new Error('404'));
    await openPlanGate();
    expect(replace).toHaveBeenCalledWith('/plans/plan-9');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Story MOTIR-6012's integration gate (MOTIR-6040): the forward is a REPLACE, so one
  // that lands after the reader already left would yank them off wherever they went.
  it.each([
    [
      'resolves',
      (settle: { resolve: (v: PlanReviewDto) => void; reject: (e: Error) => void }) =>
        settle.resolve(reviewWith({ sessionId: 's-9', hasTurns: true, targetKeys: [] })),
    ],
    [
      'fails',
      (settle: { resolve: (v: PlanReviewDto) => void; reject: (e: Error) => void }) =>
        settle.reject(new Error('aborted')),
    ],
  ] as const)(
    'a read that %s AFTER the overlay unmounted forwards nowhere',
    async (_label, finish) => {
      let settle!: { resolve: (v: PlanReviewDto) => void; reject: (e: Error) => void };
      fetchPlanReview.mockImplementation(
        () =>
          new Promise<PlanReviewDto>((resolve, reject) => {
            settle = { resolve, reject };
          }),
      );
      const view = await openPlanGate();
      const signal = fetchPlanReview.mock.calls[0]![1] as AbortSignal;
      view.unmount();
      expect(signal.aborted).toBe(true);
      await act(async () => {
        finish(settle);
      });
      expect(replace).not.toHaveBeenCalled();
      expect(shallowReplace).not.toHaveBeenCalled();
    },
  );
});
