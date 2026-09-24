// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// MOTIR-6185 — `PlanProposalViews`, the plan page's List | Canvas pane lifted into
// ONE component two hosts mount.
//
// What is pinned HERE is the component's OWN contract, and nothing else:
//   * which body renders for a given `view`, and that it is never both;
//   * that it is CONTROLLED — a press reports and changes nothing by itself,
//     which is the property that lets the plan page keep the view in the URL and
//     the planning surface keep it local (Part XXI decision 3);
//   * that `band` renders BETWEEN the header and the body (Part VIII §2);
//   * that `outcome` reaches both bodies (MOTIR-3161's three-valued decision).
//
// The plan page's own wiring — the URL binding, the pinned default, the establish
// band's predicate — stays asserted by `plan-detail-view-switch.test.tsx`, which
// this lift leaves unmodified on purpose: it is the regression net for the move.

// Both bodies are stubbed. This file is about the PANE, and a real
// `PlanReviewCanvas` would drag its level read in — the same `vi.mock` of the same
// module path `plan-detail-view-switch.test.tsx` already uses, which is why the
// lift kept both imports on their original module paths.
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: ({ outcome, ariaLabel }: { outcome: string | null; ariaLabel: string }) => (
    <div data-testid="plan-review-canvas" data-outcome={outcome ?? 'none'} aria-label={ariaLabel} />
  ),
}));

vi.mock('@/components/planning/PlanProposalList', () => ({
  PlanProposalList: ({ outcome, items }: { outcome: string | null; items: unknown[] }) => (
    <div
      data-testid="plan-proposal-list"
      data-outcome={outcome ?? 'none'}
      data-count={items.length}
    />
  ),
}));

import { PlanProposalViews } from '@/components/planning/PlanProposalViews';

const items = [{ planItemId: 'pi_1' }, { planItemId: 'pi_2' }] as unknown as PlanReviewItemDto[];

function mount(over: Partial<Parameters<typeof PlanProposalViews>[0]> = {}) {
  const onViewChange = vi.fn();
  const result = renderWithIntl(
    <PlanProposalViews
      items={items}
      outcome={null}
      projectKey="MOTIR"
      version={0}
      ariaLabel="Proposed plan"
      view="canvas"
      onViewChange={onViewChange}
      {...over}
    />,
  );
  return { ...result, onViewChange };
}

afterEach(() => cleanup());

describe('PlanProposalViews', () => {
  it('renders the switch and the canvas body, and not the list', () => {
    mount({ view: 'canvas' });

    expect(screen.getByTestId('plan-proposal-views')).toBeTruthy();
    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
    expect(screen.queryByTestId('plan-proposal-list')).toBeNull();
  });

  it('renders the list body for the list view, and not the canvas', () => {
    mount({ view: 'list' });

    expect(screen.getByTestId('plan-proposal-list')).toBeTruthy();
    expect(screen.queryByTestId('plan-review-canvas')).toBeNull();
  });

  it('carries the plan pages own accessible group name on the switch', () => {
    mount();

    // The catalogue string, not a literal this test owns — the lift introduces no
    // new key, and `planReview.viewSwitchAria` is the one the page already used.
    const group = screen.getByRole('group', { name: 'Plan view' });
    expect(group).toBeTruthy();
    expect(screen.getByRole('button', { name: /List/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Canvas/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('is CONTROLLED: a press reports the next view and changes no body by itself', () => {
    const { onViewChange } = mount({ view: 'canvas' });

    fireEvent.click(screen.getByRole('button', { name: /List/ }));

    expect(onViewChange).toHaveBeenCalledTimes(1);
    expect(onViewChange).toHaveBeenCalledWith('list');
    // The body did NOT move: the host owns the view. This is the property that
    // lets one component serve a host that keeps the view in the URL and a host
    // that keeps it in local state.
    expect(screen.getByTestId('plan-review-canvas')).toBeTruthy();
    expect(screen.queryByTestId('plan-proposal-list')).toBeNull();
  });

  it('renders `band` between the header and the body', () => {
    mount({ view: 'list', band: <div data-testid="a-band" /> });

    const root = screen.getByTestId('plan-proposal-views');
    const children = [...root.children];
    const header = children.findIndex((el) => el.querySelector('[role="group"]') !== null);
    const band = children.findIndex((el) => el.matches('[data-testid="a-band"]'));
    const body = children.findIndex((el) =>
      el.querySelector('[data-testid]') === null
        ? false
        : el.querySelector('[data-testid="plan-proposal-list"]') !== null,
    );

    expect(header).toBeGreaterThanOrEqual(0);
    expect(band).toBe(header + 1);
    expect(body).toBe(band + 1);
  });

  it('renders no band slot when none is given', () => {
    mount({ view: 'list' });

    const root = screen.getByTestId('plan-proposal-views');
    // header + body only.
    expect(root.children.length).toBe(2);
  });

  it.each(['accepted', 'declined'] as const)('passes outcome %s to the list body', (outcome) => {
    mount({ view: 'list', outcome });

    expect(screen.getByTestId('plan-proposal-list').getAttribute('data-outcome')).toBe(outcome);
  });

  it.each(['accepted', 'declined'] as const)('passes outcome %s to the canvas body', (outcome) => {
    mount({ view: 'canvas', outcome });

    expect(screen.getByTestId('plan-review-canvas').getAttribute('data-outcome')).toBe(outcome);
  });

  it('hands the items and the canvas aria-label straight through', () => {
    mount({ view: 'list' });
    expect(screen.getByTestId('plan-proposal-list').getAttribute('data-count')).toBe('2');

    cleanup();

    mount({ view: 'canvas', ariaLabel: 'The proposed plan' });
    expect(screen.getByTestId('plan-review-canvas').getAttribute('aria-label')).toBe(
      'The proposed plan',
    );
  });
});
