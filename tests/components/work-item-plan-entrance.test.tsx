// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { WorkItemPlanEntrance } from '@/components/planning/WorkItemPlanEntrance';

// The PER-ITEM Plan / Re-plan entrance (Subtask MOTIR-910; design
// `design/work-items/plan-replan-entrance.mock.html` panels 1–4). It is a pure
// affordance — the workspace behind it is shipped — so what these lock is the
// contract the design states: WHICH face it wears, WHERE it goes, and that the
// item's own key travels with it.

afterEach(cleanup);

function href(el: HTMLElement): URL {
  return new URL(el.getAttribute('href')!, 'https://motir.test');
}

describe('WorkItemPlanEntrance — the two faces', () => {
  it('reads "Plan" for an item with NO children yet', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} />);
    const link = screen.getByTestId('work-item-plan-entrance');
    expect(link.textContent).toContain('Plan');
    expect(link.textContent).not.toContain('Re-plan');
    expect(link.getAttribute('data-mode')).toBe('plan');
  });

  it('reads "Re-plan" for an item that already HAS children', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-5" hasChildren />);
    const link = screen.getByTestId('work-item-plan-entrance');
    expect(link.textContent).toContain('Re-plan');
    expect(link.getAttribute('data-mode')).toBe('replan');
  });

  it('names the ITEM in its accessible name, so several planning doors never collide', () => {
    // The global "Plan with AI" pill is on every screen; a bare "Plan" would be
    // ambiguous to a screen-reader user and to a role+name selector alike. The
    // visible text stays contained in the accessible name (WCAG 2.5.3).
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} />);
    const label = screen.getByTestId('work-item-plan-entrance').getAttribute('aria-label')!;
    expect(label).toContain('MOTIR-42');
    expect(label).toContain('Plan');
  });
});

describe('WorkItemPlanEntrance — where it goes', () => {
  it('opens the universal planning workspace SCOPED to the item', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} />);
    const url = href(screen.getByTestId('work-item-plan-entrance'));
    // Not a bespoke panel and not a per-item route: the ONE shipped workspace,
    // carrying this item as its anchor.
    expect(url.pathname).toBe('/planning');
    expect(url.searchParams.get('from')).toBe('work-item');
    expect(url.searchParams.get('item')).toBe('MOTIR-42');
  });

  it('carries the re-plan MODE when the item already has children', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-5" hasChildren />);
    expect(href(screen.getByTestId('work-item-plan-entrance')).searchParams.get('mode')).toBe(
      'replan',
    );
  });

  it('opens plain contextual planning when it does not', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} />);
    expect(href(screen.getByTestId('work-item-plan-entrance')).searchParams.get('mode')).toBe(
      'contextual',
    );
  });

  it('is a real link — keyboard-reachable and ⌘/middle-clickable, not an onClick div', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} />);
    expect(screen.getByTestId('work-item-plan-entrance').tagName).toBe('A');
  });
});

describe('WorkItemPlanEntrance — the quick-view handoff', () => {
  it('tells its host it is leaving, so the peek modal closes as the workspace opens', () => {
    const onActivate = vi.fn();
    renderWithIntl(
      <WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} onActivate={onActivate} />,
    );
    fireEvent.click(screen.getByTestId('work-item-plan-entrance'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('works without a host callback — the detail page just navigates', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} />);
    expect(() => fireEvent.click(screen.getByTestId('work-item-plan-entrance'))).not.toThrow();
  });
});
