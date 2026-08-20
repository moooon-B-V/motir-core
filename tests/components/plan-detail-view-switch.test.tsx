// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanStatusDto } from '@/lib/dto/plans';

// MOTIR-3239 — the plan detail's List ↔ Canvas SWITCHER and its URL contract.
//
// The list BODY itself is `PlanProposalList.test.tsx`; the seam and the parsing
// are `tests/planning/planView.test.ts`. What is pinned HERE is the wiring only
// the island owns: which body renders for a given URL, that switching PUSHES the
// URL rather than setting local state, and — the property that must survive
// MOTIR-3262 making the default conditional — that **the default writes a CLEAN
// url with no query parameter**, so every existing `/plans/[id]` link stays
// byte-identical.

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  search: { value: '' },
  approvePlanRequest: vi.fn(async () => ({})),
  declinePlanRequest: vi.fn(async () => ({})),
  fetchPlanReview: vi.fn(),
}));

// The search params are settable per test, because they ARE the input this file
// is about.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
  usePathname: () => '/plans/plan_1',
  useSearchParams: () => new URLSearchParams(mocks.search.value),
}));

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    approvePlanRequest: mocks.approvePlanRequest,
    declinePlanRequest: mocks.declinePlanRequest,
    fetchPlanReview: mocks.fetchPlanReview,
  };
});

vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: ({ onEditAdd }: { onEditAdd?: (id: string) => void }) => (
    <div data-testid="plan-review-canvas">
      {onEditAdd ? (
        <button type="button" onClick={() => onEditAdd('item-1')}>
          edit proposal
        </button>
      ) : null}
    </div>
  ),
}));

// The step is stubbed so it reports NOTHING unless a test asks it to — which is
// what lets the rail's code line be attributed to the refreshed prop rather than
// to the step's own mount-time report.
vi.mock('@/components/planning/repositories/RepositorySetStep', () => ({
  RepositorySetStep: ({ onOutcomeChange }: { onOutcomeChange?: (o: 'ready') => void }) => (
    <div data-testid="repository-set-step">
      <button type="button" onClick={() => onOutcomeChange?.('ready')}>
        report ready
      </button>
    </div>
  ),
}));

vi.mock('@/components/planning/ProposalEditModal', () => ({
  ProposalEditModal: ({
    item,
    onSubmit,
  }: {
    item: { planItemId: string } | null;
    onSubmit: (id: string, input: { title: string }) => void;
  }) =>
    item ? (
      <button type="button" onClick={() => onSubmit(item.planItemId, { title: 'Renamed' })}>
        save proposal
      </button>
    ) : null,
}));

import { PlanDetail } from '@/components/planning/PlanDetail';

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned' as PlanStatusDto,
    title: 'My plan',
    summary: null,
    itemCount: 2,
    createdAt: '2026-07-31T00:00:00.000Z',
    plannedAt: '2026-07-31T00:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    decisionReason: null,
    // The three-party attribution (MOTIR-2991). The default is the UNATTRIBUTED
    // state, so every pre-existing case keeps asserting a header without one and
    // each attribution state opts in explicitly.
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [
      {
        planItemId: 'item-1',
        op: 'add',
        nodeId: 'item-1',
        parentNodeId: null,
        parentIdentifier: null,
        parentTitle: null,
        parentKind: null,
        parentTrail: [],
        blockedByNodeIds: [],
        identifier: null,
        title: 'A proposed story',
        kind: 'story',
        priority: null,
        type: null,
        descriptionMd: null,
        explanationMd: null,
        explanationSource: null,
        storyPoints: null,
        estimateMinutes: null,
        targetRepo: null,
        targetRepoRole: null,
        executor: null,
        planningProvenance: null,
        status: null,
        statusLabel: null,
        statusCategory: null,
        hasChildren: false,
        changes: [],
        stale: false,
        staleReasons: [],
        targetMissing: false,
      },
    ],
    stale: false,
    staleCount: 0,
    ...over,
  };
}

/** An UNESTABLISHED set — one proposed row, which is what the page hands down the
 *  moment a plan is approved and its repositories are derived. */
const approved = () =>
  review({ status: 'approved' as PlanStatusDto, decidedByName: 'Yue', decidedAt: '2026-07-31' });

beforeEach(() => {
  mocks.search.value = '';
  mocks.fetchPlanReview.mockResolvedValue(approved());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A plan whose proposals sit under TWO distinct containers — the shape whose
 *  honest default is the list (MOTIR-3262). */
function straddling() {
  const base = review();
  return {
    ...base,
    items: [
      { ...base.items[0]!, planItemId: 'a', nodeId: 'a', parentNodeId: 'wi_story' },
      { ...base.items[0]!, planItemId: 'b', nodeId: 'b', parentNodeId: 'wi_epic' },
    ],
  };
}

describe('the DEFAULT view is DERIVED from the plan (MOTIR-3262)', () => {
  it('a STRADDLING plan opens in the LIST, with no query parameter', () => {
    renderWithIntl(<PlanDetail initialReview={straddling()} projectKey="MOTIR" />);

    expect(screen.getByTestId('plan-proposal-list')).toBeTruthy();
    expect(screen.queryByTestId('plan-review-canvas')).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('a SINGLE-container plan opens on the canvas, also with no parameter', () => {
    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);

    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('`?view=canvas` WINS on a straddling plan', () => {
    mocks.search.value = 'view=canvas';

    renderWithIntl(<PlanDetail initialReview={straddling()} projectKey="MOTIR" />);

    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
  });

  it('`?view=list` WINS on a single-container plan', () => {
    mocks.search.value = 'view=list';

    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);

    expect(screen.getByTestId('plan-proposal-list')).toBeTruthy();
  });

  it('switching AWAY from a straddling plan’s default writes the parameter', () => {
    // The clean-URL property is about THE DEFAULT, whatever the default is: on
    // this plan the canvas is the non-default, so choosing it writes `?view=`.
    renderWithIntl(<PlanDetail initialReview={straddling()} projectKey="MOTIR" />);

    fireEvent.click(screen.getByRole('button', { name: /Canvas/ }));

    expect(mocks.push).toHaveBeenCalledWith('/plans/plan_1?view=canvas', { scroll: false });
  });

  it('and switching BACK to it writes a CLEAN url', () => {
    mocks.search.value = 'view=canvas';

    renderWithIntl(<PlanDetail initialReview={straddling()} projectKey="MOTIR" />);
    fireEvent.click(screen.getByRole('button', { name: /List/ }));

    expect(mocks.push).toHaveBeenCalledWith('/plans/plan_1', { scroll: false });
  });

  it('a POLL that crosses the threshold does NOT move the reviewer', async () => {
    // ⚠️ The property the pinned default exists for. A `generating` plan's
    // proposals arrive over time, so it can cross the one-container threshold
    // WHILE somebody is reading it. The default is a SEED for the arriving
    // reader, not a controlled value.
    const generating = { ...review(), status: 'generating' as PlanStatusDto, plannedAt: null };
    mocks.fetchPlanReview.mockResolvedValue({
      ...straddling(),
      status: 'generating' as PlanStatusDto,
    });

    renderWithIntl(<PlanDetail initialReview={generating} projectKey="MOTIR" />);
    // It opened on the canvas — one container at mount.
    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();

    // The poll lands a straddling plan.
    await waitFor(() => expect(mocks.fetchPlanReview).toHaveBeenCalled(), { timeout: 4000 });

    // Still the canvas. Nothing moved, and nothing was pushed at the reader.
    await waitFor(() => expect(screen.getByTestId('plan-review-canvas')).toBeTruthy());
    expect(screen.queryByTestId('plan-proposal-list')).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe('the List / Canvas switcher (MOTIR-3239)', () => {
  it('renders a labelled group with both options, keyboard-operable', () => {
    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);

    const group = screen.getByRole('group', { name: 'Plan view' });
    expect(group).toBeTruthy();
    expect(screen.getByRole('button', { name: /List/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Canvas/ })).toBeTruthy();
  });

  it('with NO parameter it shows the DEFAULT body — the canvas', () => {
    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);

    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
    expect(screen.queryByTestId('plan-proposal-list')).toBeNull();
    expect(screen.getByRole('button', { name: /Canvas/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('`?view=list` OPENS on the list — a deep link and a reload both land here', () => {
    mocks.search.value = 'view=list';

    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);

    expect(screen.getByTestId('plan-proposal-list')).toBeTruthy();
    expect(screen.queryByTestId('plan-review-canvas')).toBeNull();
    expect(screen.getByRole('button', { name: /List/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('`?view=nonsense` falls back to the default without throwing', () => {
    mocks.search.value = 'view=nonsense';

    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);

    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
  });

  it('switching to the NON-default view PUSHES the parameter', () => {
    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);

    fireEvent.click(screen.getByRole('button', { name: /List/ }));

    expect(mocks.push).toHaveBeenCalledWith('/plans/plan_1?view=list', { scroll: false });
  });

  it('switching BACK to the default writes a CLEAN url with no parameter', () => {
    // The property that must survive MOTIR-3262 making the default conditional:
    // it is about THE DEFAULT, whatever the default is. Every existing
    // `/plans/[id]` link stays byte-identical.
    mocks.search.value = 'view=list';

    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);
    fireEvent.click(screen.getByRole('button', { name: /Canvas/ }));

    expect(mocks.push).toHaveBeenCalledWith('/plans/plan_1', { scroll: false });
  });

  it('keeps any OTHER query parameter when it writes its own', () => {
    mocks.search.value = 'peek=item-1';

    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);
    fireEvent.click(screen.getByRole('button', { name: /List/ }));

    expect(mocks.push).toHaveBeenCalledWith('/plans/plan_1?peek=item-1&view=list', {
      scroll: false,
    });
  });

  it('switching NEVER scrolls the reader to the top of a pane they were reading', () => {
    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);

    fireEvent.click(screen.getByRole('button', { name: /List/ }));

    expect(mocks.push.mock.calls[0]![1]).toEqual({ scroll: false });
  });

  it('switching reveals no server surface, so it does not refresh', () => {
    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);

    fireEvent.click(screen.getByRole('button', { name: /List/ }));

    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('the switcher is present in BOTH views — a reader is never stuck in one', () => {
    mocks.search.value = 'view=list';

    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);

    expect(screen.getByRole('group', { name: 'Plan view' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Canvas/ })).toBeTruthy();
  });
});
