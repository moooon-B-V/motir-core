// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReview, planReviewItem } from '../helpers/planReview';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';

// MOTIR-4578 — the review rail's transcript may never scroll SIDEWAYS.
//
// The defect had two halves and needed both. The scroller stated only
// `overflow-y-auto`, and CSS Overflow 3 computes an unstated `overflow-x` to
// `auto` whenever the other axis is non-visible — so the pane was one
// unbreakable token away from a scrollbar across the whole rail at any moment.
// The token duly arrived: `review.summary` carries an agent-written planning
// turn and rendered in a bare `<p>` with no wrap guard, while the `<h2>` six
// lines above it had carried `wrap-anywhere` since MOTIR-3074.
//
// ⚠️ WHAT THIS LANE CAN AND CANNOT ASSERT, stated because the card asked for the
// other one. The natural assertion is geometric — `scrollWidth === clientWidth`
// on the transcript — and **happy-dom does no layout**, exactly as
// `tests/components/combobox-portal.test.tsx` records. Every box here is 0×0, so
// that assertion reads `0 === 0` and is green on the UNFIXED component: a guard
// that cannot go red is not a guard. The geometry is therefore asserted in
// `tests/e2e/plans-review.spec.ts`, in a real browser at the real 22rem track,
// and this lane asserts the MECHANISM that produces it — which is what a unit
// render can actually see, and what goes red the moment either half is dropped.
//
// Written over the RULE rather than over today's three fields: the cases are a
// LIST of the generated strings the transcript renders, so a fourth generated
// field is added to this list rather than to a new test, and one added without a
// guard fails here.

afterEach(cleanup);

/** A token with NO line-break opportunity — no space, no `/`, no `-`. The
 *  browser breaks a path at its slashes, which is why a 47-character path does
 *  not overflow and a 44-character identifier does; the guard is only ever
 *  needed for the second kind, so that is what the fixture carries. */
const unbreakable = (label: string) => `${label}_${'X'.repeat(48)}`;

const PLAN_TITLE = unbreakable('PLANTITLE');
const PLAN_SUMMARY = unbreakable('PLANSUMMARY');
const STALE_ITEM_TITLE = unbreakable('STALEITEM');

function renderRail() {
  return renderWithIntl(
    <PlanReviewRail
      review={planReview(
        [
          planReviewItem({
            planItemId: 'pi_stale',
            title: STALE_ITEM_TITLE,
            stale: true,
            staleReasons: [{ code: 'parent_removed', parentId: 'wi_archived_parent' }],
          }),
        ],
        {
          status: 'planned',
          title: PLAN_TITLE,
          summary: PLAN_SUMMARY,
          stale: true,
          staleCount: 1,
        },
      )}
      onApprove={() => {}}
      onDecline={() => {}}
      busy={false}
      errorCode={null}
    />,
  );
}

/**
 * Is `el` reached by `overflow-wrap: anywhere`?
 *
 * `overflow-wrap` INHERITS, so the guard is satisfied by the element itself or
 * by any ancestor up to and including the transcript — which is why the stale
 * row carries it on its `<li>` and the span inside is covered. Anything above
 * the transcript does not count: the transcript is the scroll box, and a break
 * opportunity established outside it is not what stops it scrolling.
 */
function reachedByWrapGuard(el: HTMLElement, transcript: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.classList.contains('wrap-anywhere')) return true;
    if (node === transcript) return false;
  }
  return false;
}

describe('PlanReviewRail — the transcript cannot scroll sideways (MOTIR-4578)', () => {
  it('states BOTH overflow axes on the scroll region', () => {
    renderRail();
    const transcript = screen.getByTestId('plan-review-transcript');

    expect(transcript.className).toContain('overflow-y-auto');
    // `hidden`, not `auto`. `AppLayout`'s `<main>` states `overflow-x-auto`
    // because content wider than that column must stay reachable; this pane
    // holds prose, which has nothing to reveal sideways once it wraps — and
    // `auto` here would draw the very scrollbar this card is about. The nav
    // rail's scroller made the same choice for the same reason (MOTIR-4232).
    expect(transcript.className).toContain('overflow-x-hidden');
  });

  it.each([
    ['the plan title', PLAN_TITLE],
    ['the plan summary', PLAN_SUMMARY],
    ['a stale item title', STALE_ITEM_TITLE],
  ])('guards %s against an unbreakable token', (_label, text) => {
    renderRail();
    const transcript = screen.getByTestId('plan-review-transcript');
    const rendered = screen.getByText(text);

    expect(transcript.contains(rendered)).toBe(true);
    expect(reachedByWrapGuard(rendered, transcript)).toBe(true);
  });
});
