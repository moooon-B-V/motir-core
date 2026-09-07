// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// ⚠️ THE ENTRANCE READS THE ADDRESS NOW (MOTIR-4730). It used to compose a fixed
// `/planning?…` href out of nothing, so this file needed no router; the overlay
// made its destination *the page you are already on* plus the workspace's query,
// which means `usePathname` / `useSearchParams`. Without a mock the real hooks
// return `null` outside a router context and the component throws on the first
// render — 19 tests, every one of them.
let pathname = '/items/MOTIR-42';
let searchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParams,
}));

const { WorkItemPlanEntrance } = await import('@/components/planning/WorkItemPlanEntrance');

// The PER-ITEM Plan / Re-plan entrance (Subtask MOTIR-910; design
// `design/work-items/plan-replan-entrance.mock.html` panels 1–4). It is a pure
// affordance — the workspace behind it is shipped — so what these lock is the
// contract the design states: WHICH face it wears, WHERE it goes, and that the
// item's own key travels with it.

beforeEach(() => {
  pathname = '/items/MOTIR-42';
  searchParams = new URLSearchParams();
});
afterEach(cleanup);

// A live, plannable item — the state every "what the door looks like" case
// assumes. The gate itself is exercised in its own describe below.
const LIVE = {
  canPlan: true,
  archived: false,
  statusCategory: 'todo',
  kind: 'story',
  hasDescription: false,
} as const;

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
  it('opens the workspace OVER the page you are on, scoped to the item', () => {
    // ⚠️ RE-POINTED (MOTIR-4730). This asserted `/planning` — a DESTINATION.
    // The workspace is an overlay: the href is the page the reader is already
    // on, plus the workspace's own namespaced query. A door that navigated
    // would throw away the item page underneath, which is the whole point of
    // the story.
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} {...LIVE} />);
    const url = href(screen.getByTestId('work-item-plan-entrance'));
    expect(url.pathname).toBe('/items/MOTIR-42');
    expect(url.searchParams.get('planFrom')).toBe('work-item');
    expect(url.searchParams.get('planItem')).toBe('MOTIR-42');
  });

  it('keeps the host page\u2019s OWN query — it is a layer over that page, not a new address', () => {
    // The peek is the case that makes this load-bearing: `?peek=` must survive,
    // so closing the workspace returns the reader to the quick view they
    // launched from.
    pathname = '/items';
    searchParams = new URLSearchParams('peek=MOTIR-42&status=open');
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} {...LIVE} />);
    const url = href(screen.getByTestId('work-item-plan-entrance'));
    expect(url.pathname).toBe('/items');
    expect(url.searchParams.get('peek')).toBe('MOTIR-42');
    expect(url.searchParams.get('status')).toBe('open');
    expect(url.searchParams.get('planItem')).toBe('MOTIR-42');
  });

  it('carries the re-plan MODE when the item already has children', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-5" hasChildren {...LIVE} />);
    expect(href(screen.getByTestId('work-item-plan-entrance')).searchParams.get('plan')).toBe(
      'replan',
    );
  });

  it('opens plain contextual planning when it does not', () => {
    renderWithIntl(<WorkItemPlanEntrance itemKey="MOTIR-42" hasChildren={false} {...LIVE} />);
    expect(href(screen.getByTestId('work-item-plan-entrance')).searchParams.get('plan')).toBe(
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
        kind="story"
        hasDescription={false}
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
        kind="story"
        hasDescription={false}
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
        kind="story"
        hasDescription={false}
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
        kind="story"
        hasDescription={false}
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
        kind="story"
        hasDescription={false}
      />,
    );
    expect(screen.getByTestId('work-item-plan-entrance')).toBeTruthy();
  });
});

// bug MOTIR-2097 — the face used to come from `hasChildren` alone, so a LEAF
// (which can never have children) always read "Plan" however much description it
// carried. The face now follows the shared rule: description for a leaf,
// children for a container.
describe('WorkItemPlanEntrance — which face it wears', () => {
  function face(props: {
    kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask';
    hasChildren: boolean;
    hasDescription: boolean;
  }) {
    renderWithIntl(
      <WorkItemPlanEntrance
        itemKey="MOTIR-42"
        canPlan
        archived={false}
        statusCategory="todo"
        {...props}
      />,
    );
    const el = screen.getByTestId('work-item-plan-entrance');
    return { mode: el.getAttribute('data-mode'), text: el.textContent };
  }

  it('rule 2 — a DESCRIBED leaf reads Re-plan', () => {
    const { mode, text } = face({ kind: 'subtask', hasChildren: false, hasDescription: true });
    expect(mode).toBe('replan');
    expect(text).toContain('Re-plan');
  });

  it('rule 2 — an UNDESCRIBED leaf reads Plan', () => {
    const { mode, text } = face({ kind: 'subtask', hasChildren: false, hasDescription: false });
    expect(mode).toBe('plan');
    expect(text).not.toContain('Re-plan');
  });

  it('rule 3 — a childless container reads Plan even WITH a description', () => {
    expect(face({ kind: 'epic', hasChildren: false, hasDescription: true }).mode).toBe('plan');
  });

  it('rule 3 — a container WITH children reads Re-plan', () => {
    expect(face({ kind: 'epic', hasChildren: true, hasDescription: false }).mode).toBe('replan');
  });

  it('the workspace MODE follows the face, not hasChildren', () => {
    // A described leaf opens the workspace in replan mode, which `hasPlan` drives.
    renderWithIntl(
      <WorkItemPlanEntrance
        itemKey="MOTIR-42"
        kind="task"
        hasChildren={false}
        hasDescription
        canPlan
        archived={false}
        statusCategory="todo"
      />,
    );
    expect(href(screen.getByTestId('work-item-plan-entrance')).searchParams.get('plan')).toBe(
      'replan',
    );
  });
});
