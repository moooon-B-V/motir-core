// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanStatusDto } from '@/lib/dto/plans';

// MOTIR-1377 — a DECLINED plan must show its decided OUTCOME, not the empty state.
// `declinePlan` drops every PlanItem, so a declined plan's review model carries
// `items: []`. Before the fix, `PlanDetail`'s `isEmpty` guard (items.length === 0
// && status !== 'generating') matched a declined plan and rendered the
// "no proposals" empty state, SHADOWING the review rail's declined-outcome branch
// ("Plan declined …"). These tests pin: a decided (declined/approved) plan flows
// to the rail regardless of item count, while a genuinely-empty *planned* plan
// still shows the empty state. The heavy roadmap canvas is stubbed — it is
// irrelevant to this branch (and exercised by the real-DB + E2E plan suites).
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: () => <div data-testid="plan-review-canvas" />,
}));

import { PlanDetail } from '@/components/planning/PlanDetail';

afterEach(cleanup);

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned' as PlanStatusDto,
    title: 'My plan',
    summary: null,
    itemCount: 0,
    createdAt: '2026-06-26T00:00:00.000Z',
    plannedAt: '2026-06-26T00:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    history: [],
    items: [],
    stale: false,
    staleCount: 0,
    ...over,
  };
}

describe('PlanDetail — decided plans reach the review rail (MOTIR-1377)', () => {
  it('renders the DECLINED outcome (not the empty state) for a declined plan with no items', () => {
    renderWithIntl(
      <PlanDetail
        initialReview={review({ status: 'declined', decidedByName: 'Yue', items: [] })}
      />,
    );

    expect(screen.getByText('Plan declined — your tree was left untouched')).toBeTruthy();
    // The empty "no proposals" state must NOT shadow the rail.
    expect(screen.queryByText('This plan has no proposals')).toBeNull();
  });

  it('still shows the EMPTY state for a genuinely-empty planned plan (no over-broad fix)', () => {
    renderWithIntl(<PlanDetail initialReview={review({ status: 'planned', items: [] })} />);

    expect(screen.getByText('This plan has no proposals')).toBeTruthy();
    expect(screen.queryByText('Plan declined — your tree was left untouched')).toBeNull();
  });

  it('renders the APPROVED outcome for an approved plan', () => {
    renderWithIntl(
      <PlanDetail
        initialReview={review({ status: 'approved', itemCount: 1, decidedByName: 'Yue' })}
      />,
    );

    expect(screen.getByText('Added 1 item to your backlog')).toBeTruthy();
    expect(screen.queryByText('This plan has no proposals')).toBeNull();
  });
});
