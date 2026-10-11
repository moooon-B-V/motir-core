// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { ReaderRoutesProvider } from '@/lib/visitor/useReaderRoutes';

// THE PLAN-OVERLAY DOOR (Story MOTIR-7883 · MOTIR-7884).
//
// A door that holds only a plan id resolves it through the review read and lands
// where `planRowDestination` says: the overlay IN PLACE for an undecided plan with
// a session, the plan page otherwise. These cases pin the click rule around the
// read — a modified click stays the browser's, a plain click never navigates for
// an undecided plan — and that N doors to one plan read it once.

let pathname = '/items/MOTIR-12';
let searchParams = new URLSearchParams();
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParams,
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { PlanOverlayDoor } = await import('@/components/planning/PlanOverlayDoor');
const { useOpenPlanOverlay } = await import('@/lib/hooks/useOpenPlanOverlay');

const fetchMock = vi.fn();

function reviewBody(
  status: string,
  conversation: { sessionId: string; targetKeys: string[] } | null,
) {
  return new Response(JSON.stringify({ status, conversation }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function answer(status: string, conversation: { sessionId: string; targetKeys: string[] } | null) {
  fetchMock.mockImplementation(async () => reviewBody(status, conversation));
}

beforeEach(() => {
  pathname = '/items/MOTIR-12';
  searchParams = new URLSearchParams('tab=activity');
  push.mockReset();
  shallowPush.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HOST = '/items/MOTIR-12?tab=activity';

/** Render one door and let its read settle. */
async function renderDoor(
  ui = (
    <PlanOverlayDoor planId="p_1" data-testid="door">
      Review
    </PlanOverlayDoor>
  ),
) {
  render(ui);
  await act(async () => {});
  return screen.getByTestId('door');
}

describe('an undecided plan with a session', () => {
  it('a plain click opens the overlay project-wide IN PLACE and never navigates', async () => {
    answer('planned', { sessionId: 's1', targetKeys: [] });
    const door = await renderDoor();
    const expected = withPlanningOverlay(HOST, { kind: 'project', sessionId: 's1' });
    expect(door.getAttribute('href')).toBe(expected);

    const event = fireEvent.click(door, { button: 0 });
    expect(event).toBe(false); // preventDefault'd
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(expected);
    expect(push).not.toHaveBeenCalled();
  });

  it('carries the work-item context when the session is anchored', async () => {
    answer('stale', { sessionId: 's1', targetKeys: ['MOTIR-12', 'MOTIR-13'] });
    const door = await renderDoor();
    fireEvent.click(door, { button: 0 });
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(
      withPlanningOverlay(HOST, { kind: 'work-item', itemKey: 'MOTIR-12', sessionId: 's1' }),
    );
  });

  it('a door given `via` carries it on the overlay address, project-wide and anchored alike', async () => {
    answer('planned', { sessionId: 's1', targetKeys: [] });
    const project = await renderDoor(
      <PlanOverlayDoor planId="p_1" via="resume" data-testid="door">
        Open
      </PlanOverlayDoor>,
    );
    expect(project.getAttribute('href')).toBe(
      withPlanningOverlay(HOST, { kind: 'project', sessionId: 's1', via: 'resume' }),
    );
    cleanup();
    fetchMock.mockReset();
    answer('planned', { sessionId: 's2', targetKeys: ['MOTIR-12'] });
    const anchored = await renderDoor(
      <PlanOverlayDoor planId="p_2" via="resume" data-testid="door">
        Open
      </PlanOverlayDoor>,
    );
    fireEvent.click(anchored, { button: 0 });
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(
      withPlanningOverlay(HOST, {
        kind: 'work-item',
        itemKey: 'MOTIR-12',
        sessionId: 's2',
        via: 'resume',
      }),
    );
  });

  it('leaves every modified click to the browser, on the full overlay address', async () => {
    answer('generating', { sessionId: 's1', targetKeys: [] });
    const door = await renderDoor();
    expect(door.getAttribute('href')).toBe(
      withPlanningOverlay(HOST, { kind: 'project', sessionId: 's1' }),
    );
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const handled = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...init,
      });
      act(() => {
        door.dispatchEvent(handled);
      });
      expect(handled.defaultPrevented).toBe(false);
    }
    expect(shallowPush).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('a click that beats the read waits on it, then opens in place', async () => {
    let settle: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (settle = r)));
    render(
      <PlanOverlayDoor planId="p_1" data-testid="door">
        Review
      </PlanOverlayDoor>,
    );
    const door = screen.getByTestId('door');
    // Before the read: the plan page, and no pending affordance.
    expect(door.getAttribute('href')).toBe('/plans/p_1');

    const event = fireEvent.click(door, { button: 0 });
    expect(event).toBe(false);
    expect(shallowPush).not.toHaveBeenCalled();

    await act(async () => {
      settle(reviewBody('planned', { sessionId: 's1', targetKeys: [] }));
    });
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(
      withPlanningOverlay(HOST, { kind: 'project', sessionId: 's1' }),
    );
    expect(push).not.toHaveBeenCalled();
  });
});

describe('everything else lands on the plan page', () => {
  it.each(['approved', 'declined'])('a %s plan', async (status) => {
    answer(status, { sessionId: 's1', targetKeys: ['MOTIR-12'] });
    const door = await renderDoor();
    expect(door.getAttribute('href')).toBe('/plans/p_1');
    fireEvent.click(door, { button: 0 });
    expect(push).toHaveBeenCalledExactlyOnceWith('/plans/p_1');
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('a Visitor reader gets the Visitor plan page, never the overlay', async () => {
    answer('planned', { sessionId: 's1', targetKeys: [] });
    render(
      <ReaderRoutesProvider identifier="ACME">
        <PlanOverlayDoor planId="p_1" data-testid="door">
          Review
        </PlanOverlayDoor>
      </ReaderRoutesProvider>,
    );
    await act(async () => {});
    const door = screen.getByTestId('door');
    expect(door.getAttribute('href')).toBe('/p/ACME/plans/p_1');
    fireEvent.click(door, { button: 0 });
    expect(push).toHaveBeenCalledExactlyOnceWith('/p/ACME/plans/p_1');
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('a read that fails falls back to the plan page', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }));
    const door = await renderDoor();
    expect(door.getAttribute('href')).toBe('/plans/p_1');
    fireEvent.click(door, { button: 0 });
    expect(push).toHaveBeenCalledExactlyOnceWith('/plans/p_1');
    expect(shallowPush).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  it('makes no read when the caller supplies the facts', async () => {
    const door = await renderDoor(
      <PlanOverlayDoor
        planId="p_1"
        known={{ planStatus: 'planned', sessionId: 's9', anchorKey: 'MOTIR-7' }}
        data-testid="door"
      >
        Planned
      </PlanOverlayDoor>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(door, { button: 0 });
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(
      withPlanningOverlay(HOST, { kind: 'work-item', itemKey: 'MOTIR-7', sessionId: 's9' }),
    );
  });

  it('two doors to one plan read it once, and two plans read once each', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/p_2')
        ? reviewBody('planned', { sessionId: 's2', targetKeys: [] })
        : reviewBody('planned', { sessionId: 's1', targetKeys: [] }),
    );
    render(
      <>
        <PlanOverlayDoor planId="p_1" data-testid="a">
          A
        </PlanOverlayDoor>
        <PlanOverlayDoor planId="p_1" data-testid="b">
          B
        </PlanOverlayDoor>
        <PlanOverlayDoor planId="p_2" data-testid="c">
          C
        </PlanOverlayDoor>
      </>,
    );
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('a').getAttribute('href')).toBe(
      screen.getByTestId('b').getAttribute('href'),
    );
    expect(screen.getByTestId('c').getAttribute('href')).toBe(
      withPlanningOverlay(HOST, { kind: 'project', sessionId: 's2' }),
    );
  });
});

describe('open() with no event — the imperative form', () => {
  it('opens the overlay for an undecided plan', async () => {
    answer('planned', { sessionId: 's1', targetKeys: [] });
    let door: ReturnType<typeof useOpenPlanOverlay> | null = null;
    function Probe() {
      door = useOpenPlanOverlay('p_1');
      return null;
    }
    render(<Probe />);
    await act(async () => {});
    expect(door!.resolved).toBe(true);
    act(() => door!.open());
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(
      withPlanningOverlay(HOST, { kind: 'project', sessionId: 's1' }),
    );
  });
});

describe('the `host` option — a door where the overlay is not mounted (MOTIR-7890)', () => {
  it('composes the address on that host and NAVIGATES there', async () => {
    answer('planned', { sessionId: 's1', targetKeys: ['MOTIR-12'] });
    let door: ReturnType<typeof useOpenPlanOverlay> | null = null;
    function Probe() {
      door = useOpenPlanOverlay('p_1', undefined, { host: '/plans' });
      return null;
    }
    render(<Probe />);
    await act(async () => {});
    const expected = withPlanningOverlay('/plans', {
      kind: 'work-item',
      itemKey: 'MOTIR-12',
      sessionId: 's1',
    });
    expect(door!.href).toBe(expected);
    act(() => door!.open());
    expect(push).toHaveBeenCalledExactlyOnceWith(expected);
    expect(shallowPush).not.toHaveBeenCalled();
  });
});
