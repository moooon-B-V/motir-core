// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';

const { loadMorePlansAction } = vi.hoisted(() => ({ loadMorePlansAction: vi.fn() }));
vi.mock('@/app/(authed)/plans/_actions', () => ({ loadMorePlansAction }));

// The windowing hook is passed through UNCHANGED unless a test sets
// `forceRange` — the one case that needs it is the guarded dereference, which
// has no other way to reach an out-of-range index in happy-dom.
const { forceRange } = vi.hoisted(() => ({
  forceRange: { value: null as null | [number, number] },
}));
vi.mock('@/components/ui/useRowWindow', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/ui/useRowWindow')>();
  return {
    ...real,
    useRowWindow: (opts: Parameters<typeof real.useRowWindow>[0]) => {
      const out = real.useRowWindow(opts);
      if (!forceRange.value) return out;
      const [start, end] = forceRange.value;
      return { ...out, windowing: true, range: { start, end } };
    },
  };
});

import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlansList } from '@/app/(authed)/plans/_components/PlansList';
import type { PlanRowView } from '@/app/(authed)/plans/_components/types';

// MOTIR-3241, the client half: the `Load more` BUTTON is gone and a bottom
// sentinel streams the next page instead — `ReadyList`'s shipped shape, adopted
// verbatim.
//
// ⚠️ WHAT THIS FILE CANNOT ASSERT, said here so nobody adds it and believes it.
// The shrink-on-switch crash the row dereference is guarded against
// (`useRowWindow` keeps its `range` in `useState` and recomputes it in a layout
// effect, so the render right after the row count DROPS still holds the older,
// larger bounds) is INVISIBLE in happy-dom: with no measurable viewport the hook
// degrades to render-all, `indices` is always in range, and a test of it passes
// while a real browser throws. The real-browser assertion is the story's E2E
// card's. What IS assertable here is the GUARD's own behaviour — that an
// out-of-range slot renders nothing instead of throwing — which the last
// describe below drives by forcing the hook to hand back a stale, too-large
// window. That is the mechanism, staged; the crash is the browser's to prove.

/** Every `IntersectionObserver` constructed during a render, so a test can fire
 *  one by hand. `useRowWindow` constructs one of its own, so the sentinel's is
 *  picked out by its look-ahead rather than by position — see `sentinels()`. */
let observers: { cb: IntersectionObserverCallback; options?: IntersectionObserverInit }[] = [];

/** Just the LIST's cursor sentinel observers — the ones armed with the 600px
 *  look-ahead. Filtering by the option rather than by index keeps this test from
 *  breaking the day the windowing hook changes how many of its own it arms. */
const sentinels = () => observers.filter((o) => o.options?.rootMargin === '600px');

class FakeIO {
  disconnected = false;
  constructor(
    public cb: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    observers.push({ cb, options });
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  root = null;
  rootMargin = '';
  thresholds = [];
}

function views(n: number, from = 0): PlanRowView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `plan_${from + i}`,
    status: 'planned' as const,
    origin: 'user' as const,
    createdByName: null,
    decidedByName: null,
    authorSource: null,
    authorHarness: null,
    title: `Plan ${from + i}`,
    itemCount: 3,
    staleCount: 0,
    // A small level, so the derived default is the CANVAS unless a case says
    // otherwise (MOTIR-4024).
    arrivalLevelSize: 1,
    arrivalLevelTotal: 1,
    whenKey: 'plannedAt' as const,
    whenLabel: '2 hours ago',
  }));
}

beforeEach(() => {
  observers = [];
  forceRange.value = null;
  vi.stubGlobal('IntersectionObserver', FakeIO);
  loadMorePlansAction.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PlansList streams on scroll (MOTIR-3241)', () => {
  it('renders NO `Load more` button', () => {
    renderWithIntl(<PlansList initialViews={views(3)} initialCursor="cur_1" status="planned" />);

    // The button had exactly one job and the sentinel has it now. Its absence is
    // asserted rather than assumed, because a re-added button would still stream
    // correctly and quietly reintroduce the surface this card removed.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('arms an observer with the 600px look-ahead while a cursor remains', () => {
    renderWithIntl(<PlansList initialViews={views(3)} initialCursor="cur_1" status="planned" />);

    expect(sentinels()).toHaveLength(1);
  });

  it('arms NOTHING at the tail — a finished list observes nothing', () => {
    renderWithIntl(<PlansList initialViews={views(3)} initialCursor={null} status="planned" />);

    expect(sentinels()).toHaveLength(0);
  });

  it('streams the next page when the sentinel intersects, carrying the STATUS', async () => {
    loadMorePlansAction.mockResolvedValue({ views: views(2, 3), nextCursor: null });
    renderWithIntl(<PlansList initialViews={views(3)} initialCursor="cur_1" status="approved" />);

    await act(async () => {
      sentinels()[0]!.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as never);
    });

    // The cursor AND the tab. A cursor is only meaningful inside the predicate
    // that produced it, so a page streamed without the status would page the
    // whole project from a position computed inside one of them.
    expect(loadMorePlansAction).toHaveBeenCalledWith('cur_1', 'approved');
    expect(screen.getByText('Plan 4')).toBeTruthy();
  });

  it('does not re-enter while a load is in flight', async () => {
    let release!: () => void;
    loadMorePlansAction.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ views: views(2, 3), nextCursor: null });
      }),
    );
    renderWithIntl(<PlansList initialViews={views(3)} initialCursor="cur_1" status="planned" />);

    // The observer fires repeatedly while the sentinel sits in view.
    await act(async () => {
      sentinels()[0]!.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as never);
      sentinels()[0]!.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as never);
      sentinels()[0]!.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as never);
    });

    expect(loadMorePlansAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
    });
  });

  it('a non-intersecting entry loads nothing', async () => {
    loadMorePlansAction.mockResolvedValue({ views: [], nextCursor: null });
    renderWithIntl(<PlansList initialViews={views(3)} initialCursor="cur_1" status="planned" />);

    await act(async () => {
      sentinels()[0]!.cb([{ isIntersecting: false } as IntersectionObserverEntry], {} as never);
    });

    expect(loadMorePlansAction).not.toHaveBeenCalled();
  });

  it('renders every row it is given, and each links to its plan', () => {
    renderWithIntl(<PlansList initialViews={views(4)} initialCursor={null} status="planned" />);

    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByRole('link', { name: /Plan 0/ }).getAttribute('href')).toBe('/plans/plan_0');
  });
});

describe('the row dereference is GUARDED against a stale window (MOTIR-3241)', () => {
  // `useRowWindow` keeps its `range` in `useState` and recomputes it only in a
  // post-render layout effect. On the render right after the row count DROPS —
  // thirty rows deep in `Approved`, switching to a two-row `Generating` — the
  // range still holds the OLD, larger bounds. `views[index]!` is then `undefined`
  // and `.id` throws, taking the page down.
  //
  // happy-dom cannot produce that stale range on its own (no measurable viewport
  // ⇒ the hook degrades to render-all), so it is STAGED here: the hook is forced
  // to return a window wider than the row set, which is exactly the state the
  // browser is in for one frame.

  it('renders the in-range rows and does not throw when the window overruns them', () => {
    forceRange.value = [0, 30];

    expect(() =>
      renderWithIntl(
        <PlansList initialViews={views(2)} initialCursor={null} status="generating" />,
      ),
    ).not.toThrow();

    // The two real rows render; the 28 phantom slots render nothing, and the
    // layout effect re-windows on the next frame.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Plan 0')).toBeTruthy();
    expect(screen.getByText('Plan 1')).toBeTruthy();
  });

  it('an entirely out-of-range window renders no rows rather than throwing', () => {
    forceRange.value = [10, 20];

    expect(() =>
      renderWithIntl(<PlansList initialViews={views(2)} initialCursor={null} status="planned" />),
    ).not.toThrow();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});
