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
// that half. This file covers the element itself: the two faces, the two op
// sentences, the untitled-plan fallback, the link targets and the accessible
// name.

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

const modifyBy = (planId: string, planTitle: string | null): WorkItemPendingProposalDto => ({
  planId,
  planTitle,
  planStatus: 'planned',
  op: 'modify',
});
const removeBy = (planId: string, planTitle: string | null): WorkItemPendingProposalDto => ({
  planId,
  planTitle,
  planStatus: 'stale',
  op: 'remove',
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

describe('PendingPlanNotice — the empty case', () => {
  it('renders NOTHING for an empty proposal set — no reserved box', () => {
    const { container } = renderWithIntl(<PendingPlanNotice identifier="PROD-49" proposals={[]} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('pending-plan-notice')).toBeNull();
  });
});
