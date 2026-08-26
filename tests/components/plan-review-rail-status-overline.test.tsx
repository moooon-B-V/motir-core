// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanStatusDto } from '@/lib/dto/plans';

// MOTIR-3074 — the review rail's status tag COLLIDED with the plan title. The
// title and a `shrink-0` pill shared one `flex items-center` row, so a long title
// wrapped to four or five lines while the one-line pill stayed centred against the
// block: the tag landed inside the title's text column and read as an annotation
// on line 3 of the sentence. Underneath it was the repo's `min-w-0` overflow class
// — a flex/grid item's automatic minimum size is its longest unbreakable word, and
// plan titles are GENERATED, so `SHARED_PLANNING_RULES` or a 25-character cuid
// pushed the `<aside>` past its fixed 22rem track.
//
// These are STRUCTURAL assertions on purpose: happy-dom reports all-zero geometry,
// so the pixel half of the acceptance criterion — no horizontal overflow, the tag
// clear of the title — is measured in a real browser by `plans-review.spec.ts`
// ("a long unbreakable title never overflows the rail"). What this file pins is
// the shape that fix depends on, so the collapse cannot silently return.

afterEach(cleanup);

// A title carrying BOTH unbreakable tokens from the report: a SCREAMING_CASE
// constant and a cuid. Either one alone is wider than the rail's text column.
const LONG_TITLE =
  'Mirror the sweep-is-not-its-grep-pattern limb into SHARED_PLANNING_RULES (motir-ai) — supersedes plan cmszanri500bfi3phws7wdiu8';

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned' as PlanStatusDto,
    title: LONG_TITLE,
    summary: null,
    itemCount: 3,
    createdAt: '2026-08-19T00:00:00.000Z',
    plannedAt: '2026-08-19T00:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    decisionReason: null,
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [],
    stale: false,
    staleCount: 0,
    revision: null,
    ...over,
  };
}

function renderRail(over: Partial<PlanReviewDto> = {}) {
  return renderWithIntl(
    <PlanReviewRail
      review={review(over)}
      onApprove={() => {}}
      onDecline={() => {}}
      busy={false}
      errorCode={null}
    />,
  );
}

describe('PlanReviewRail header — the status tag is an overline, not a pill on the title line (MOTIR-3074)', () => {
  it('puts the tag on its OWN line above the title, so nothing shares the title column', () => {
    renderRail();

    const pill = screen.getByTestId('plan-status-pill');
    const heading = screen.getByRole('heading', { level: 2, name: LONG_TITLE });

    // Same parent — the `<header>` — and that parent stacks its children, so the
    // title has the whole rail width and no sibling sits beside it.
    expect(pill.parentElement).toBe(heading.parentElement);
    expect(pill.parentElement?.tagName).toBe('HEADER');
    expect(pill.parentElement?.className).toContain('flex-col');
    expect(pill.parentElement?.className).not.toContain('items-center');

    // The tag is READ FIRST: it precedes the title in document order.
    expect(pill.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // …at its own width, not stretched across the rail by the column's default
    // `align-items: stretch`.
    expect(pill.className).toContain('self-start');
  });

  it('carries the overflow guard on the title itself — required wherever the tag sits', () => {
    renderRail();
    const heading = screen.getByRole('heading', { level: 2, name: LONG_TITLE });

    // `wrap-anywhere` (overflow-wrap: anywhere), NOT `break-words`: only
    // `anywhere` feeds its break opportunities into the min-content size the
    // rail's fixed track is measured from.
    expect(heading.className).toContain('wrap-anywhere');
    expect(heading.className).toContain('min-w-0');

    // And the rail itself is floored, so no descendant can widen the 22rem track.
    const rail = screen.getByRole('complementary', { name: 'Plan review' });
    expect(rail.className).toContain('min-w-0');
  });

  it.each([
    ['generating', 'Generating'],
    ['planned', 'Ready to review'],
    ['approved', 'Approved'],
    ['declined', 'Declined'],
  ] as const)('keeps the tag readable and tinted for %s', (status, label) => {
    renderRail({ status });

    // The hook the shipped E2E + component suites read is unchanged by the move.
    const pill = screen.getByTestId('plan-status-pill');
    expect(pill.textContent).toContain(label);
    // STATUS_TINT keeps its full coverage — every status carries a tint class,
    // and the text is what conveys the state (never colour alone).
    expect(pill.className).toMatch(/bg-\(--el-(tint-\w+|muted)\)/);
  });
});
