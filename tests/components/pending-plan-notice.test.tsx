// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PendingPlanNotice } from '@/app/(authed)/items/[key]/_components/PendingPlanNotice';
import type { WorkItemPendingProposalDto } from '@/lib/dto/plans';

// The PENDING-PLAN indicator on the work-item detail page (bug MOTIR-4197 ·
// design MOTIR-4256) under happy-dom, against the real `en` catalogue — the
// copy asserted here is the copy the design's §6 table fixes, byte for byte.
//
// The PAGE decides whether to mount this (no undecided plan ⇒ nothing; no
// `ai:view_plan` ⇒ nothing, and no read) — `item-detail-reads.test.tsx` guards
// that half. This file covers the element itself: the two faces, the FIVE claim
// sentences, the untitled-plan fallback, the link targets and the accessible
// name.
//
// ⚠️ WIDENED by bug MOTIR-4365 · design MOTIR-4364 AMENDMENT A §A1: a plan can
// also propose CHILDREN under this card, so the form is total over five claims —
// `modify` · `remove` · `add` · `modify`+`add` · `remove`+`add` — each carrying
// the child count in an ICU plural. A sixth (`modify`+`remove`) is excluded by
// `@@unique([planId, workItemId])` rather than by choice.

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
});

const modifyBy = (
  planId: string,
  planTitle: string | null,
  childCount = 0,
): WorkItemPendingProposalDto => ({
  planId,
  planTitle,
  planStatus: 'planned',
  op: 'modify',
  childCount,
});
const removeBy = (
  planId: string,
  planTitle: string | null,
  childCount = 0,
): WorkItemPendingProposalDto => ({
  planId,
  planTitle,
  planStatus: 'stale',
  op: 'remove',
  childCount,
});
/** The CHILDREN-ONLY claim: `op: null`, which is the shape an expansion takes. */
const addBy = (
  planId: string,
  planTitle: string | null,
  childCount: number,
): WorkItemPendingProposalDto => ({
  planId,
  planTitle,
  planStatus: 'planned',
  op: null,
  childCount,
});

describe('PendingPlanNotice — ONE plan', () => {
  it('a `modify` says a plan proposes CHANGES, and the control links to that plan', () => {
    renderWithIntl(
      <PendingPlanNotice identifier="PROD-49" proposals={[modifyBy('pln_8f21', 'Epic 8 sweep')]} />,
    );

    const notice = screen.getByTestId('pending-plan-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(screen.getByText('A plan proposes changes to this item')).toBeTruthy();
    // The reason the element is not alarming: the page being read is still true.
    expect(
      screen.getByText(
        'Nothing here has changed yet — the proposal applies only if the plan is approved.',
      ),
    ).toBeTruthy();

    // The control is a REAL link (navigation keeps link semantics), its
    // accessible name is op-neutral and CONTAINS the visible label (WCAG 2.5.3).
    const link = screen.getByRole('link', { name: 'Review the plan that names PROD-49' });
    expect(link.getAttribute('href')).toBe('/plans/pln_8f21');
    expect(link.textContent).toContain('Review plan');
  });

  it('a `remove` is a DIFFERENT sentence — a plan proposes to ARCHIVE this item', () => {
    renderWithIntl(
      <PendingPlanNotice identifier="PROD-49" proposals={[removeBy('pln_a417', 'Cancel 8.6')]} />,
    );
    expect(screen.getByText('A plan proposes to archive this item')).toBeTruthy();
    expect(screen.queryByText('A plan proposes changes to this item')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Review the plan that names PROD-49' }).getAttribute('href'),
    ).toBe('/plans/pln_a417');
  });

  it('a `stale` plan shows the SAME copy and the same link as a `planned` one', () => {
    // Whether a plan has drifted is the PLAN's property; the item page points
    // at it and does not describe it (design §5).
    renderWithIntl(
      <PendingPlanNotice
        identifier="PROD-49"
        proposals={[{ ...modifyBy('pln_st', 'Drifted'), planStatus: 'stale' }]}
      />,
    );
    expect(screen.getByText('A plan proposes changes to this item')).toBeTruthy();
    expect(screen.queryByText(/stale/i)).toBeNull();
  });
});

describe('PendingPlanNotice — SEVERAL plans become a LIST', () => {
  it('one row per plan, the plan NAME as the link, its own op sentence, no control', () => {
    renderWithIntl(
      <PendingPlanNotice
        identifier="PROD-49"
        proposals={[
          modifyBy('pln_8f21', 'Epic 8 — launch-readiness sweep'),
          removeBy('pln_a417', 'Cancel the abandoned 8.6 branch'),
          modifyBy('pln_c903', null),
        ]}
      />,
    );

    expect(screen.getByText('3 pending plans name this item')).toBeTruthy();

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);

    const first = screen.getByRole('link', { name: 'Epic 8 — launch-readiness sweep' });
    expect(first.getAttribute('href')).toBe('/plans/pln_8f21');
    expect(rows[0]!.textContent).toContain('— proposes changes');

    const second = screen.getByRole('link', { name: 'Cancel the abandoned 8.6 branch' });
    expect(second.getAttribute('href')).toBe('/plans/pln_a417');
    expect(rows[1]!.textContent).toContain('— proposes to archive it');

    // `Plan.title` is nullable: the SHIPPED `planReview.untitledPlan` string is
    // reused, so the item page and the review surface say one thing about an
    // unnamed plan.
    const third = screen.getByRole('link', { name: 'Untitled plan' });
    expect(third.getAttribute('href')).toBe('/plans/pln_c903');

    // The single-plan control is gone: one control cannot name three plans.
    expect(screen.queryByRole('link', { name: /Review the plan that names/ })).toBeNull();
    expect(screen.queryByText('Review plan')).toBeNull();
  });

  it('a blank title falls back to the untitled string too', () => {
    renderWithIntl(
      <PendingPlanNotice
        identifier="PROD-49"
        proposals={[modifyBy('a', '   '), modifyBy('b', 'Named')]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Untitled plan' }).getAttribute('href')).toBe(
      '/plans/a',
    );
  });
});

describe('PendingPlanNotice — the CHILDREN claims (MOTIR-4365 · AMENDMENT A §A1)', () => {
  it('an `add`-only plan says a plan proposes to ADD n work items, and keeps the control', () => {
    renderWithIntl(
      <PendingPlanNotice
        identifier="PROD-49"
        proposals={[addBy('pln_8f21', 'Expand PROD-49 into subtasks', 8)]}
      />,
    );

    expect(screen.getByText('A plan proposes to add 8 work items under this item')).toBeTruthy();
    // Neither shipped op sentence appears: the claim is not a change and not an
    // archive, and the distinction is carried in words, never in hue.
    expect(screen.queryByText('A plan proposes changes to this item')).toBeNull();
    expect(screen.queryByText('A plan proposes to archive this item')).toBeNull();

    const link = screen.getByRole('link', { name: 'Review the plan that names PROD-49' });
    expect(link.getAttribute('href')).toBe('/plans/pln_8f21');
  });

  it('ONE child takes the SINGULAR arm of the same key — the plural is ICU, not a branch', () => {
    renderWithIntl(
      <PendingPlanNotice identifier="PROD-49" proposals={[addBy('pln_one', 'Add one', 1)]} />,
    );
    expect(screen.getByText('A plan proposes to add 1 work item under this item')).toBeTruthy();
  });

  it('`modify` + `add` is ONE sentence with two clauses — the shipped voice, extended', () => {
    renderWithIntl(
      <PendingPlanNotice
        identifier="PROD-49"
        proposals={[modifyBy('pln_mix', 'Rework and expand', 8)]}
      />,
    );
    expect(
      screen.getByText('A plan proposes changes to this item, and 8 work items under it'),
    ).toBeTruthy();
    // The plain `modify` headline is REPLACED, not appended to.
    expect(screen.queryByText('A plan proposes changes to this item')).toBeNull();
  });

  it('`remove` + `add` is expressible and incoherent, and is drawn anyway — it is the tell', () => {
    // A plan that archives a card while hanging work beneath it is exactly the
    // plan somebody should look at. Suppressing the children clause to tidy the
    // sentence would hide it (AMENDMENT A §A1, on the record).
    renderWithIntl(
      <PendingPlanNotice identifier="PROD-49" proposals={[removeBy('pln_odd', 'Cancel 8.6', 3)]} />,
    );
    expect(
      screen.getByText('A plan proposes to archive this item, and 3 work items under it'),
    ).toBeTruthy();
  });

  it('the LIST face carries the same five claims as row sentences, and the count counts PLANS', () => {
    renderWithIntl(
      <PendingPlanNotice
        identifier="PROD-49"
        proposals={[
          addBy('pln_8f21', 'Expand PROD-49 into subtasks', 8),
          modifyBy('pln_a417', 'Epic 8 — launch-readiness sweep', 2),
          removeBy('pln_c903', 'Cancel the abandoned 8.6 branch', 0),
        ]}
      />,
    );

    // THREE, not thirteen. The array is one row per PLAN (the service's fold),
    // so `pendingPlanCountHeadline` goes back to meaning what it says — the
    // string itself is unchanged and needed no new plural arm.
    expect(screen.getByText('3 pending plans name this item')).toBeTruthy();

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('— proposes 8 work items under it');
    expect(rows[1]!.textContent).toContain('— proposes changes, and 2 work items under it');
    expect(rows[2]!.textContent).toContain('— proposes to archive it');
    expect(rows[2]!.textContent).not.toContain('under it');

    // The single-plan control is gone here as it is for the shipped ops.
    expect(screen.queryByRole('link', { name: /Review the plan that names/ })).toBeNull();
  });

  it('a row with ONE child takes the singular arm too', () => {
    renderWithIntl(
      <PendingPlanNotice
        identifier="PROD-49"
        proposals={[addBy('a', 'One', 1), modifyBy('b', 'Two', 1)]}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('— proposes 1 work item under it');
    expect(rows[1]!.textContent).toContain('— proposes changes, and 1 work item under it');
  });
});

describe('PendingPlanNotice — the empty case', () => {
  it('renders NOTHING for an empty proposal set — no reserved box', () => {
    const { container } = renderWithIntl(<PendingPlanNotice identifier="PROD-49" proposals={[]} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('pending-plan-notice')).toBeNull();
  });
});
