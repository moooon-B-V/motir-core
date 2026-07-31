// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanStatusDto } from '@/lib/dto/plans';
import type { ProjectRepoEstablishViewDto } from '@/lib/dto/projectRepos';

// MOTIR-1947 — APPROVING a plan must reveal the establish step in the SAME page
// view. The step is rendered from a SERVER read the page performs only for an
// approved plan (`repositorySet`), while the review itself lives in this client
// island's `useState`. That makes approve the page-state contract's "a mutation
// touching BOTH does BOTH" case: the client refetch cannot produce the prop, and
// `router.refresh()` cannot reach the island's state. Before the fix only the
// refetch ran, so the canvas kept showing the proposals — the step appeared only
// on a later navigation — and the rail's approved outcome carried no code line.
//
// What is pinned here is the ROUTING of each surface to its mechanism, so the
// bug cannot come back quietly: approve does both, decline and the proposal
// inline edit do NEITHER (surface kind 1 must not refresh), and the rail's code
// line follows the refreshed PROP — not a seed that only ever ran at mount.
//
// The heavy canvas and the establish step are stubbed: this is a test about which
// update mechanism each action fires, and the step's own screen is covered by
// `RepositorySetStep.test.tsx` plus the Story's acceptance E2E.

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  approvePlanRequest: vi.fn(async () => ({})),
  declinePlanRequest: vi.fn(async () => ({})),
  updateProposalRequest: vi.fn(async () => ({})),
  fetchPlanReview: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    approvePlanRequest: mocks.approvePlanRequest,
    declinePlanRequest: mocks.declinePlanRequest,
    updateProposalRequest: mocks.updateProposalRequest,
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
import { PlanRequestError } from '@/lib/planning/planReviewClient';

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
    history: [],
    items: [
      {
        planItemId: 'item-1',
        op: 'add',
        nodeId: 'item-1',
        parentNodeId: null,
        blockedByNodeIds: [],
        identifier: null,
        title: 'A proposed story',
        kind: 'story',
        priority: null,
        type: null,
        descriptionMd: null,
        status: null,
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
function repositorySet(): { projectKey: string; view: ProjectRepoEstablishViewDto } {
  return {
    projectKey: 'MOTIR',
    view: {
      set: {
        projectId: 'proj_1',
        rows: [
          {
            id: 'repo-1',
            projectId: 'proj_1',
            role: 'web',
            name: 'motir-web',
            label: null,
            state: 'proposed',
            position: 'a0',
            seedSource: 'nextjs-prisma-vercel-starter',
            failureReason: null,
            proposalSignal: null,
            realizedRepo: null,
            established: false,
            takeover: null,
            access: { state: 'not_invited', login: null, invitationUrl: null },
            createdAt: '2026-07-31T00:00:00.000Z',
            updatedAt: '2026-07-31T00:00:00.000Z',
          },
        ],
        ownership: null,
        targetAccount: null,
      },
      hostOwner: 'motir-projects',
      githubLogin: null,
      githubAvatarUrl: null,
      hasInstallation: false,
      connectCandidates: [],
    },
  };
}

const approved = () =>
  review({ status: 'approved' as PlanStatusDto, decidedByName: 'Yue', decidedAt: '2026-07-31' });

beforeEach(() => {
  mocks.fetchPlanReview.mockResolvedValue(approved());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PlanDetail — approving refreshes the SERVER surface too (MOTIR-1947)', () => {
  it('approve refetches the review AND refreshes the server read that produces the step', async () => {
    renderWithIntl(<PlanDetail initialReview={review()} repositorySet={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));

    await waitFor(() => expect(mocks.approvePlanRequest).toHaveBeenCalledWith('plan_1'));
    // BOTH mechanisms — the island's own refetch for the review it owns, and the
    // refresh for the establish step only the server can render.
    await waitFor(() => expect(mocks.fetchPlanReview).toHaveBeenCalled());
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it('still updates the review itself — the refresh does not replace the client refetch', async () => {
    renderWithIntl(<PlanDetail initialReview={review()} repositorySet={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));

    // The rail's decided outcome comes from the island's own state, which only the
    // refetch can move.
    expect(await screen.findByText('Added 2 items to your backlog')).toBeTruthy();
  });

  it('shows the step and its rail line when the refresh delivers the prop — with no remount', async () => {
    const { rerender } = renderWithIntl(
      <PlanDetail initialReview={review()} repositorySet={null} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();

    // What `router.refresh()` produces: the SAME island instance re-rendered with
    // the repo set the server could only read once the plan was approved.
    rerender(<PlanDetail initialReview={review()} repositorySet={repositorySet()} />);

    expect(screen.getByTestId('repository-set-step')).toBeTruthy();
    expect(screen.queryByTestId('plan-review-canvas')).toBeNull();
  });

  it('carries the rail code line from a prop delivered AFTER mount — not a mount-time seed', () => {
    // The refresh's payload reaches a LIVE island: same instance, new props. A
    // `useState(() => …)` seed runs once and would leave the approved outcome
    // with no code line at all, which is the second half of the reported defect.
    const { rerender } = renderWithIntl(
      <PlanDetail initialReview={approved()} repositorySet={null} />,
    );
    expect(screen.queryByTestId('plan-code-outcome')).toBeNull();

    rerender(<PlanDetail initialReview={approved()} repositorySet={repositorySet()} />);

    expect(screen.getByTestId('plan-code-outcome').textContent).toContain(
      'Finish setting up repositories',
    );
  });

  it('lets the step OVERRIDE the derived outcome once it reports its own', async () => {
    renderWithIntl(<PlanDetail initialReview={approved()} repositorySet={repositorySet()} />);

    expect(screen.getByTestId('plan-code-outcome').textContent).toContain(
      'Finish setting up repositories',
    );

    fireEvent.click(screen.getByRole('button', { name: 'report ready' }));

    expect(screen.getByTestId('plan-code-outcome').textContent).toContain('Your code is ready');
  });

  it('refreshes on a 409 too — a concurrent reviewer approved, so the step is just as due', async () => {
    mocks.approvePlanRequest.mockRejectedValueOnce(new PlanRequestError(409, 'ALREADY_DECIDED'));

    renderWithIntl(<PlanDetail initialReview={review()} repositorySet={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it('DECLINE does not refresh — it reveals no server-rendered surface', async () => {
    mocks.fetchPlanReview.mockResolvedValue(review({ status: 'declined' as PlanStatusDto }));

    renderWithIntl(<PlanDetail initialReview={review()} repositorySet={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Decline/i }));

    await waitFor(() => expect(mocks.declinePlanRequest).toHaveBeenCalledWith('plan_1'));
    await waitFor(() => expect(mocks.fetchPlanReview).toHaveBeenCalled());
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('the proposal INLINE EDIT does not refresh — surface kind 1 must keep its own value', async () => {
    mocks.fetchPlanReview.mockResolvedValue(review());

    renderWithIntl(<PlanDetail initialReview={review()} repositorySet={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'edit proposal' }));
    fireEvent.click(screen.getByRole('button', { name: 'save proposal' }));

    await waitFor(() => expect(mocks.updateProposalRequest).toHaveBeenCalled());
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
