// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanStatusDto } from '@/lib/dto/plans';

// PANEL 9 (bug MOTIR-5049 · design `design/repository-set/design-notes.md` §7b,
// v6) — WHEN the establish band is drawn over an approved plan's canvas, and
// what the reader is left with when it is not.
//
// The defect these pin: the band's gate was a row COUNT
// (`app/(authed)/plans/[id]/page.tsx`'s `repoView.set.rows.length > 0`), which
// asks how many rows exist and never whether any of them has anything left to
// establish. Since MOTIR-4753 made a repository a precondition of planning at
// all, every BYOK project approves a plan and gets *"Motir will host your code"*
// across the top of the pane — over repositories its ORGANISATION already owns,
// connected during onboarding, with the plan it just approved pushed below the
// fold and no dismissal on any later visit.
//
// ⚠️ BOTH POPULATIONS ARE TOLD APART BY DATA ALONE. Every case below differs
// only in the DTO's row `state` / `seedSource` — never in a prop, a flag or a
// fixture switch — because that is the claim the fix makes: the discriminator
// was already on the wire (`ProjectRepoEstablishViewDto.set.rows[]` carries
// both) and the surface simply never asked for it.
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: ({ outcome, items }: { outcome?: string | null; items: unknown[] }) => (
    <div
      data-testid="plan-review-canvas"
      data-outcome={outcome ?? ''}
      data-item-count={items.length}
    />
  ),
}));

// The step is a whole subtree with its own client calls; these cases are about
// WHETHER it renders, so it stands in as a marker. What it SAYS on a mixed set
// is pinned in `tests/components/RepositorySetStep.test.tsx`.
vi.mock('@/components/planning/repositories/RepositorySetStep', () => ({
  RepositorySetStep: () => <div data-testid="repository-set-step" />,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/plans/plan_1',
  useSearchParams: () => new URLSearchParams(),
}));

import { PlanDetail } from '@/components/planning/PlanDetail';
import { planReviewItem } from '../helpers/planReview';

afterEach(cleanup);

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'approved' as PlanStatusDto,
    title: 'My plan',
    summary: null,
    itemCount: 1,
    createdAt: '2026-06-26T00:00:00.000Z',
    plannedAt: '2026-06-26T00:00:00.000Z',
    decidedAt: '2026-09-10T21:41:00.000Z',
    decidedByName: 'Yue',
    decisionReason: null,
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [planReviewItem({ planItemId: 'pi_1', identifier: 'PRJ-9' })],
    stale: false,
    staleCount: 0,
    arrivalLevelSize: 1,
    arrivalLevelTotal: 1,
    revision: null,
    ...over,
  };
}

/** One row of the establish view, as the wire carries it. */
function row(state: string, seedSource: string, accessState = 'not_invited') {
  return { state, seedSource, access: { state: accessState } };
}

function repositorySet(rows: ReturnType<typeof row>[]) {
  return { projectKey: 'PRJ', view: { set: { rows } } as never };
}

describe('PlanDetail — a SETTLED repository set draws NO establish band (MOTIR-5049)', () => {
  it('draws NO band for an all-`connected` ORGANISATION-owned set — the canvas has the whole pane', () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        repositorySet={repositorySet([
          row('connected', 'organization'),
          row('connected', 'organization'),
        ])}
        initialReview={review()}
      />,
    );

    // The whole defect, in one assertion.
    expect(screen.queryByTestId('plan-detail-establish-band')).toBeNull();
    expect(screen.queryByTestId('repository-set-step')).toBeNull();
    // …and the thing the user actually approved is what is on the page.
    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
  });

  it("STILL renders the rail's approved-outcome line for that set — it is the WHOLE answer", () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        repositorySet={repositorySet([row('connected', 'organization')])}
        initialReview={review()}
      />,
    );

    // ⚠️ THE REGRESSION THIS CASE EXISTS FOR, and it is the one the obvious fix
    // causes. `repositorySet` feeds TWO consumers: the band, and — through
    // `codeOutcomeOf` — this line. Gating the PROP on the band's predicate (in
    // the page, or here) removes the band AND silently takes the rail's only
    // sentence about the user's code with it, for exactly the population §7b
    // says the rail is the whole answer for. Absence of the band is only half
    // the fix; this is the other half.
    expect(screen.getByText('Your code is ready')).toBeTruthy();
    expect(screen.queryByTestId('plan-detail-establish-band')).toBeNull();
  });

  it('draws no band for an all-`skipped` set either — nothing to establish, whatever the seed source', () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        repositorySet={repositorySet([row('skipped', 'initialised')])}
        initialReview={review()}
      />,
    );

    expect(screen.queryByTestId('plan-detail-establish-band')).toBeNull();
  });
});

describe('PlanDetail — an UNSETTLED set still draws the band, unchanged (MOTIR-5049)', () => {
  it("draws the band for a start-fresh `proposed` set — approval is that flow's only repo-producing exit", () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        repositorySet={repositorySet([row('proposed', 'nextjs-prisma-vercel-starter', 'unknown')])}
        initialReview={review()}
      />,
    );

    const band = screen.getByTestId('plan-detail-establish-band');
    expect(screen.getByTestId('repository-set-step')).toBeTruthy();
    // Still STACKED, never replacing — Part VI §4 is narrowed by v6, not undone.
    const canvas = screen.getByTestId('plan-review-canvas');
    expect(band.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws the band for a `created` set — settled, and the step still owes its REPORT', () => {
    // ⚠️ THE CASE THAT RULES OUT THE TEMPTING PREDICATE. `created` is SETTLED
    // (ADR §4.1: no legal move left), so "draw the band iff the set is
    // unsettled" — and equally `codeOutcomeOf(...) !== 'ready'` — would drop the
    // band here, taking `AccessReport` with it: a repository Motir just made,
    // and no surface saying which account was invited to it. `created` is the
    // ONE state where establish-work stops being the negation of settled, which
    // is what forbids writing either predicate in terms of the other.
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        repositorySet={repositorySet([row('created', 'nextjs-prisma-vercel-starter', 'invited')])}
        initialReview={review()}
      />,
    );

    expect(screen.getByTestId('plan-detail-establish-band')).toBeTruthy();
  });

  it('draws the band for a `failed` set — a failure is resumable HERE', () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        repositorySet={repositorySet([row('failed', 'nextjs-prisma-vercel-starter', 'unknown')])}
        initialReview={review()}
      />,
    );

    expect(screen.getByTestId('plan-detail-establish-band')).toBeTruthy();
  });

  it('draws the band for a MIXED set — one row Motir creates beside one the organisation owns', () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        repositorySet={repositorySet([
          row('connected', 'organization'),
          row('proposed', 'nextjs-prisma-vercel-starter', 'unknown'),
        ])}
        initialReview={review()}
      />,
    );

    // There IS a row to establish, so the step has a real question to ask. What
    // it may CLAIM over the organisation's row is the step's own test.
    expect(screen.getByTestId('plan-detail-establish-band')).toBeTruthy();
  });
});
