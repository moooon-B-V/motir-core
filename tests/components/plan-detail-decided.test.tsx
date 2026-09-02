// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanStatusDto } from '@/lib/dto/plans';

// MOTIR-1377 — a DECLINED plan must show its decided OUTCOME, not the empty state.
// Before the fix, `PlanDetail`'s `isEmpty` guard (items.length === 0 && status
// !== 'generating') matched a declined plan and rendered the "no proposals"
// empty state, SHADOWING the review rail's declined-outcome branch ("Plan
// declined …"). These tests pin: a decided (declined/approved) plan flows to the
// rail regardless of item count. The heavy roadmap canvas is stubbed — it is
// irrelevant to this branch (and exercised by the real-DB + E2E plan suites).
//
// ⚠️ AMENDED AGAIN by MOTIR-4124, and this time the guard is GONE rather than
// narrowed. The clause that stood here — "while a genuinely-empty *planned*
// plan still shows the empty state" — was the defect written down as a
// property: the hand-off was an early `return`, so it suppressed the rail, and
// the only plans that could reach it were the two UNDECIDED statuses. A plan
// nobody can approve or decline is not a plan a reviewer can do anything with,
// and one undecided plan pauses its project's cadence indefinitely. The server
// no longer closes an empty plan into `planned` at all, and this surface no
// longer has a branch that can replace the rail.
//
// ⚠️ AMENDED by MOTIR-3161 (bug MOTIR-3154). This header used to open with
// *"`declinePlan` drops every PlanItem, so a declined plan's review model
// carries `items: []`"*. That is no longer true: MOTIR-3160 RETAINS the rows,
// because not writing to the tree is what declining means and erasing the
// proposal was a separate act nobody asked for. So a declined plan is no longer
// empty, and the `!decided` guard no longer covers for that.
//
// The guard STAYS, and MOTIR-1377's assertions stay with it — but the reason has
// moved: a plan decided with genuinely zero proposals still has an outcome to
// state, and the discovery hand-off is the wrong thing to say about it. The
// cases below now pin BOTH halves: the outcome in the rail, and the cards it
// decided about on the canvas beside it.
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  // Stubbed, but it now REPORTS the two props this card is about, so a test can
  // assert the canvas is mounted and what outcome it was handed without pulling
  // the real roadmap canvas into a unit render.
  PlanReviewCanvas: ({ outcome, items }: { outcome?: string | null; items: unknown[] }) => (
    <div
      data-testid="plan-review-canvas"
      data-outcome={outcome ?? ''}
      data-item-count={items.length}
    />
  ),
}));

// The establish step is a whole subtree with its own client calls; Panel H is
// about WHERE it renders, not what it says, so it stands in as a marker.
vi.mock('@/components/planning/repositories/RepositorySetStep', () => ({
  RepositorySetStep: () => <div data-testid="repository-set-step" />,
}));

// The island reads the router to refresh the page's SERVER read on approve
// (MOTIR-1947); a unit render has no app-router context to invariant against.
// `PlanDetail` reads the URL for its view (MOTIR-3239), so the navigation stub
// covers the three hooks it uses. An empty `useSearchParams` is the default-view
// path, which is the canvas — what these tests were written against.
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
    status: 'planned' as PlanStatusDto,
    title: 'My plan',
    summary: null,
    itemCount: 0,
    createdAt: '2026-06-26T00:00:00.000Z',
    plannedAt: '2026-06-26T00:00:00.000Z',
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
    items: [],
    stale: false,
    staleCount: 0,
    // A small level, so the derived default is the CANVAS unless a case says
    // otherwise (MOTIR-4024).
    arrivalLevelSize: 1,
    arrivalLevelTotal: 1,
    revision: null,
    ...over,
  };
}

describe('PlanDetail — decided plans reach the review rail (MOTIR-1377)', () => {
  it('renders the DECLINED outcome (not the empty state) for a declined plan with no items', () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        initialReview={review({ status: 'declined', decidedByName: 'Yue', items: [] })}
      />,
    );

    expect(screen.getByText('Plan declined — your tree was left untouched')).toBeTruthy();
    // The empty "no proposals" state must NOT shadow the rail.
    expect(screen.queryByText('This plan has no proposals')).toBeNull();
  });

  // ⚠️ REWRITTEN, NOT DELETED (MOTIR-4124). This case read *"still shows the
  // EMPTY state for a genuinely-empty planned plan (no over-broad fix)"* — and
  // it was pinning the defect. The empty state was an early `return`, so it took
  // `PlanReviewRail` with it: the ONE plan a reviewer could do nothing about was
  // the one plan they were handed no Approve and no Decline for, while it went
  // on pausing that project's auto-plan cadence. The server no longer writes
  // this shape (an empty close is DISCARDED), and the rows that predate it must
  // still be endable from the page, which is what this now asserts.
  it('a zero-item plan AWAITING A DECISION keeps its rail — the hand-off never replaces the decide door', () => {
    renderWithIntl(
      <PlanDetail projectKey="PRJ" initialReview={review({ status: 'planned', items: [] })} />,
    );

    // The rail is mounted: the plan can be decided.
    expect(screen.getByRole('button', { name: /Decline/ })).toBeTruthy();
    expect(screen.queryByText('This plan has no proposals')).toBeNull();
    // …and the pane still renders, with nothing in it, rather than being
    // replaced by a terminal state.
    expect(screen.getByTestId('plan-review-canvas').getAttribute('data-item-count')).toBe('0');

    // ⚠️ EXTENDED IN PLACE by MOTIR-4146. Everything above is right and stays:
    // the rail belongs on this plan. What it was never asked is what the rail
    // OFFERS once it is here — and the answer it inherited was the whole decide
    // gate, Approve included, reading *"Approve — add 0 items to your backlog"*
    // two inches under a pane saying nothing will change if you approve it.
    // The ending is the only decision there is, so it is the only one drawn.
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByText(/add 0 items/)).toBeNull();
    // NOT-RENDERED rather than disabled: a disabled primary is a control a
    // reader hunts for the key to, and there is no key.
    expect((screen.getByRole('button', { name: /Decline/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  // The COUNTERFACTUAL for the case above (MOTIR-4146) — the suppression is
  // about the empty set and nothing else. Without this, "renders no Approve"
  // would be satisfied by a rail that renders no Approve on any plan at all.
  it('a plan holding ONE item still renders Approve — the zero branch is the only thing that changed', () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        initialReview={review({
          status: 'planned',
          itemCount: 1,
          items: [planReviewItem({ planItemId: 'pi_1' })],
        })}
      />,
    );

    const approve = screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    expect(approve.textContent).toContain('add 1 item');
  });

  // ── THE FIFTH STATUS (MOTIR-3578, AMENDMENT 9 D6) ────────────────────────
  it('a STALE plan is NOT decided — the rail states it, and the pane keeps its proposals', () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        initialReview={review({
          status: 'stale',
          itemCount: 2,
          items: [planReviewItem({ planItemId: 'pi_1' }), planReviewItem({ planItemId: 'pi_2' })],
        })}
      />,
    );

    // ⚠️ THE FAILURE THIS GUARDS IS THE ONE THIS FILE ALREADY RECORDS HAPPENING.
    // `decided` gates the discovery hand-off, and a `stale` plan has no outcome
    // yet — it is live, awaiting action, and its proposals are exactly what the
    // reviewer needs to read. Read as DECIDED, the rail would swap its controls
    // for the read-only outcome block; that is MOTIR-1377's shape with a
    // different status.
    expect(screen.getByTestId('plan-stale-outcome').textContent).toContain(
      'Plan out of date — work it changes has since been finished.',
    );
    expect(screen.queryByText('Plan declined — your tree was left untouched')).toBeNull();
    // The proposals are still drawn — the reviewer can read what they are
    // deciding about, which is the whole reason the plan is still in the queue.
    expect(screen.getByTestId('plan-review-canvas').getAttribute('data-item-count')).toBe('2');
  });

  it('an EMPTY stale plan keeps its rail too — the same door, on the other undecided status', () => {
    // ⚠️ REWRITTEN with its `planned` twin above (MOTIR-4124), and for the same
    // reason: `stale` is the second status the Plans list presents as awaiting a
    // decision, so a zero-item one hit the identical dead end. MOTIR-3578's
    // point — that `stale` is NOT decided and its outcome is not the rail's
    // read-only block — is unchanged and is asserted by the case above it.
    renderWithIntl(
      <PlanDetail projectKey="PRJ" initialReview={review({ status: 'stale', items: [] })} />,
    );

    expect(screen.getByRole('button', { name: /Decline/ })).toBeTruthy();
    expect(screen.queryByText('This plan has no proposals')).toBeNull();

    // …and, per MOTIR-4146, no Approve on this status either. `stale` is the
    // OTHER undecided status, so it inherits the same gate and inherited the
    // same defect — which is why both halves are asserted on both, rather than
    // on the one that happened to be reported.
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByText(/add 0 items/)).toBeNull();
    expect((screen.getByRole('button', { name: /Decline/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  // The THIRD undecided status (MOTIR-4146). `generating` already had its own
  // ending — the Discard MOTIR-3240 gave it — and it kept a DISABLED Approve
  // beside it whose label spends the count. At zero that label is the same
  // sentence this card is removing, so the rule is one rule: no Approve control
  // over an empty plan, whatever undecided status it wears. The ending stays.
  it('an EMPTY generating plan offers its DISCARD and no Approve — one rule across the three undecided statuses', () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        initialReview={review({ status: 'generating', plannedAt: null, items: [] })}
      />,
    );

    const discard = screen.getByTestId('plan-discard') as HTMLButtonElement;
    expect(discard.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByText(/add 0 items/)).toBeNull();
  });

  it('shows the declined outcome ALONGSIDE the cards it decided about', () => {
    // The half MOTIR-1377 could not assert, because there were no cards left to
    // show. The rows survive now, so the outcome and the record coexist.
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        initialReview={review({
          status: 'declined',
          decidedByName: 'Yue',
          itemCount: 2,
          items: [planReviewItem({ planItemId: 'pi_1' }), planReviewItem({ planItemId: 'pi_2' })],
        })}
      />,
    );

    expect(screen.getByText('Plan declined — your tree was left untouched')).toBeTruthy();
    const canvas = screen.getByTestId('plan-review-canvas');
    expect(canvas.getAttribute('data-item-count')).toBe('2');
    expect(canvas.getAttribute('data-outcome')).toBe('declined');
  });

  // MOTIR-3189 — the rendered half of "the timeline distinguishes the three".
  // The three endings all leave `status: 'declined'`, so the OUTCOME block reads
  // `decisionReason` to pick its sentence. Getting this wrong is not cosmetic:
  // it tells somebody whose generation crashed that a person read their plan and
  // rejected it.
  describe('a DISCARDED / ABANDONED plan does not read as one somebody rejected', () => {
    const REVIEWED = 'Plan declined — your tree was left untouched';

    it('a DISCARDED plan says it was discarded before it finished', () => {
      renderWithIntl(
        <PlanDetail
          projectKey="PRJ"
          initialReview={review({
            status: 'declined',
            decisionReason: 'discarded',
            decidedByName: 'Yue',
            plannedAt: null,
            itemCount: 1,
            items: [planReviewItem({ planItemId: 'pi_1' })],
          })}
        />,
      );

      expect(
        screen.getByText('Plan discarded before it finished — your work items are unchanged'),
      ).toBeTruthy();
      expect(screen.queryByText(REVIEWED)).toBeNull();
    });

    it('an ABANDONED plan says the generation never finished', () => {
      renderWithIntl(
        <PlanDetail
          projectKey="PRJ"
          initialReview={review({
            status: 'declined',
            decisionReason: 'abandoned',
            // Nobody decided it — the sweep leaves `decidedById` null.
            decidedByName: null,
            plannedAt: null,
            itemCount: 2,
            items: [planReviewItem({ planItemId: 'pi_1' }), planReviewItem({ planItemId: 'pi_2' })],
          })}
        />,
      );

      expect(
        screen.getByText('Generation never finished — this plan was ended automatically'),
      ).toBeTruthy();
      expect(screen.queryByText(REVIEWED)).toBeNull();
    });

    it('a `reviewed` reason and a NULL one both keep the original wording', () => {
      // A null is *not recorded* — every row written before the column existed —
      // and the original sentence is the one that was true for those plans.
      for (const decisionReason of ['reviewed', null] as const) {
        renderWithIntl(
          <PlanDetail
            projectKey="PRJ"
            initialReview={review({ status: 'declined', decisionReason, decidedByName: 'Yue' })}
          />,
        );
        expect(screen.getByText(REVIEWED)).toBeTruthy();
        cleanup();
      }
    });
  });

  it('renders the APPROVED outcome for an approved plan', () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        initialReview={review({ status: 'approved', itemCount: 1, decidedByName: 'Yue' })}
      />,
    );

    expect(screen.getByText('Added 1 item to your backlog')).toBeTruthy();
    expect(screen.queryByText('This plan has no proposals')).toBeNull();
  });
});

// ── Panel H (MOTIR-3161 / bug MOTIR-3154) — what the pane holds AFTER approve ──
//
// This pins a RE-DECISION, and names it so nobody re-derives the old rule from
// the code. Story MOTIR-1775 / MOTIR-1782 decided the establish step REPLACES
// the canvas, on the stated reasoning that *"once the plan has materialized, the
// canvas of proposals has served its purpose."* `design/ai-planning/design-notes.md`
// Part VI §4 overturns the PREMISE rather than the conclusion: after MOTIR-3160
// and MOTIR-3161 the pane holds the RECORD of the decision, not the proposals,
// and a record is produced by the decision rather than spent by it. The step is a
// TASK and the canvas is a RECORD, so they STACK — band above, canvas below.
describe('PlanDetail — the pane after approve (design Part VI §4)', () => {
  // The minimum `codeOutcomeOf` reads — one proposed row, which is exactly what
  // `approvePlan`'s repository-set proposal creates and what puts the step on the
  // page in the first place.
  const repositorySet = {
    projectKey: 'PRJ',
    view: {
      set: { rows: [{ state: 'proposed', access: { state: 'unknown' } }] },
    } as never,
  };

  it('STACKS the establish step above the canvas — it no longer replaces it', () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        repositorySet={repositorySet}
        initialReview={review({
          status: 'approved',
          itemCount: 1,
          decidedByName: 'Yue',
          items: [planReviewItem({ planItemId: 'pi_1', identifier: 'PRJ-9' })],
        })}
      />,
    );

    // BOTH. The old rule rendered only the first of these.
    expect(screen.getByTestId('repository-set-step')).toBeTruthy();
    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
    // …and the band is ABOVE the canvas, which is the whole of "stacked".
    const band = screen.getByTestId('plan-detail-establish-band');
    const canvas = screen.getByTestId('plan-review-canvas');
    expect(band.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(canvas.getAttribute('data-outcome')).toBe('accepted');
  });

  it('renders NO band when there is no repository set — a decline never proposes one', () => {
    renderWithIntl(
      <PlanDetail
        projectKey="PRJ"
        initialReview={review({
          status: 'declined',
          decidedByName: 'Yue',
          itemCount: 1,
          items: [planReviewItem({ planItemId: 'pi_1' })],
        })}
      />,
    );

    expect(screen.queryByTestId('plan-detail-establish-band')).toBeNull();
    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
  });
});
