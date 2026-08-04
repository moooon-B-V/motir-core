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

// A live, plannable item — the state every "what the door looks like" case
// assumes. The gate itself is exercised in its own describe below.
const LIVE = { canPlan: true, archived: false, statusCategory: 'todo' } as const;

function href(el: HTMLElement): URL {
  return new URL(el.getAttribute('href')!, 'https://motir.test');
}

describe('WorkItemPlanEntrance — the two faces', () => {
  it('reads "Plan" for an item with NO children yet', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} {...LIVE} />);
    const link = screen.getByTestId('work-item-plan-entrance');
    expect(link.textContent).toContain('Plan');
    expect(link.textContent).not.toContain('Re-plan');
    expect(link.getAttribute('data-mode')).toBe('plan');
  });

  it('reads "Re-plan" for an item that already HAS children', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-5" hasChildren {...LIVE} />);
    const link = screen.getByTestId('work-item-plan-entrance');
    expect(link.textContent).toContain('Re-plan');
    expect(link.getAttribute('data-mode')).toBe('replan');
  });

  it('names the ITEM in its accessible name, so several planning doors never collide', () => {
    // The global "Plan with AI" pill is on every screen; a bare "Plan" would be
    // ambiguous to a screen-reader user and to a role+name selector alike. The
    // visible text stays contained in the accessible name (WCAG 2.5.3).
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} {...LIVE} />);
    const label = screen.getByTestId('work-item-plan-entrance').getAttribute('aria-label')!;
    expect(label).toContain('MOTIR-42');
    expect(label).toContain('Plan');
  });
});

describe('WorkItemPlanEntrance — where it goes', () => {
  it('opens the universal planning workspace SCOPED to the item', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} {...LIVE} />);
    const url = href(screen.getByTestId('work-item-plan-entrance'));
    // Not a bespoke panel and not a per-item route: the ONE shipped workspace,
    // carrying this item as its anchor.
    expect(url.pathname).toBe('/planning');
    expect(url.searchParams.get('from')).toBe('work-item');
    expect(url.searchParams.get('item')).toBe('MOTIR-42');
  });

  it('carries the re-plan MODE when the item already has children', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-5" hasChildren {...LIVE} />);
    expect(href(screen.getByTestId('work-item-plan-entrance')).searchParams.get('mode')).toBe(
      'replan',
    );
  });

  it('opens plain contextual planning when it does not', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} {...LIVE} />);
    expect(href(screen.getByTestId('work-item-plan-entrance')).searchParams.get('mode')).toBe(
      'contextual',
    );
  });

  it('is a real link — keyboard-reachable and ⌘/middle-clickable, not an onClick div', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} {...LIVE} />);
    expect(screen.getByTestId('work-item-plan-entrance').tagName).toBe('A');
  });
});

describe('WorkItemPlanEntrance — the quick-view handoff', () => {
  it('tells its host it is leaving, so the peek modal closes as the workspace opens', () => {
    const onActivate = vi.fn();
    renderWithIntl(
      <WorkItemPlanEntrance
        itemKey="MOTIR-42"
        hasChildren={false}
        {...LIVE}
        onActivate={onActivate}
      />,
    );
    fireEvent.click(screen.getByTestId('work-item-plan-entrance'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('works without a host callback — the detail page just navigates', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} {...LIVE} />);
    expect(() => fireEvent.click(screen.getByTestId('work-item-plan-entrance'))).not.toThrow();
  });
});

// bug MOTIR-2084 — the gate now travels WITH the component, so a host that
// mounts it cannot forget a state (the boolean had been inlined at two call
// sites and grown one bug at a time). Every host inherits these.
describe('WorkItemPlanEntrance — when it does not render at all', () => {
  it('draws nothing on a DONE item — the engine refuses to re-plan finished work', () => {
    renderWithIntl(
      <WorkItemPlanEntrance
        itemKey="MOTIR-42"
        hasChildren={false}
        canPlan
        archived={false}
        statusCategory="done"
      />,
    );
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });

  it('draws nothing on a done item WITH children either — the Re-plan face is gated too', () => {
    // The Re-plan face is the one the invariant bites hardest: re-planning IS
    // proposing modify/remove, which `validatePlanProposals` rejects with 409.
    renderWithIntl(
      <WorkItemPlanEntrance
        itemKey="MOTIR-5"
        hasChildren
        canPlan
        archived={false}
        statusCategory="done"
      />,
    );
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });

  it('draws nothing on an ARCHIVED item (MOTIR-2050), whatever its status says', () => {
    renderWithIntl(
      <WorkItemPlanEntrance
        itemKey="MOTIR-42"
        hasChildren={false}
        canPlan
        archived
        statusCategory="todo"
      />,
    );
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });

  it('draws nothing for an actor who cannot plan', () => {
    renderWithIntl(
      <WorkItemPlanEntrance
        itemKey="MOTIR-42"
        hasChildren={false}
        canPlan={false}
        archived={false}
        statusCategory="todo"
      />,
    );
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });

  it('still draws on in-progress work — the gate is not over-broad', () => {
    renderWithIntl(
      <WorkItemPlanEntrance
        itemKey="MOTIR-42"
        hasChildren={false}
        canPlan
        archived={false}
        statusCategory="in_progress"
      />,
    );
    expect(screen.getByTestId('work-item-plan-entrance')).toBeTruthy();
  });
});
