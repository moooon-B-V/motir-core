// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

const { loadMoreSessionsAction } = vi.hoisted(() => ({ loadMoreSessionsAction: vi.fn() }));
vi.mock('@/app/(authed)/plans/_actions', () => ({ loadMoreSessionsAction }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/plans',
  useSearchParams: () => new URLSearchParams(),
}));

// The windowing hook is passed through UNCHANGED unless a test sets
// `forceRange` — the guarded dereference has no other way to reach an
// out-of-range index in happy-dom (no measurable viewport → render-all).
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
import { SessionsList } from '@/app/(authed)/plans/_components/SessionsList';
import type { SessionRowView } from '@/app/(authed)/plans/_components/types';

// MOTIR-6025 — the Plans list of CONVERSATIONS, the client half (the successor
// of `PlansList-streaming`, MOTIR-3241). The sentinel streams the next page; a
// failed page says so and offers Retry on the same cursor (§19.5 panel 8); a
// `?session=` landing is highlighted and scrolled to, and a pinned row is not
// listed twice when its own page arrives.

let observers: { cb: IntersectionObserverCallback; options?: IntersectionObserverInit }[] = [];
/** The LIST's cursor sentinel observers — armed with the 600px look-ahead. */
const sentinels = () => observers.filter((o) => o.options?.rootMargin === '600px');

class FakeIO {
  constructor(
    public cb: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    observers.push({ cb, options });
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  root = null;
  rootMargin = '';
  thresholds = [];
}

function views(n: number, from = 0): SessionRowView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s_${from + i}`,
    origin: 'conversation' as const,
    title: `Conversation ${from + i}`,
    targetKeys: [],
    activeLabel: '2 hours ago',
    startedByName: 'Mara',
    latestPlan: null,
    planCount: 0,
  }));
}

async function fireSentinel() {
  const io = sentinels().at(-1)!;
  await act(async () => {
    io.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

const rowIds = () =>
  Array.from(document.querySelectorAll('[data-session-row]')).map((el) =>
    el.getAttribute('data-session-row'),
  );

beforeEach(() => {
  observers = [];
  forceRange.value = null;
  vi.stubGlobal('IntersectionObserver', FakeIO);
  loadMoreSessionsAction.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SessionsList streams on scroll', () => {
  it('is the labelled list of conversations, one listitem per session', () => {
    renderWithIntl(<SessionsList initialViews={views(3)} initialCursor={null} planState={null} />);

    const list = screen.getByRole('list', { name: 'Planning conversations' });
    expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(3);
  });

  it('arms the sentinel only while a cursor remains', () => {
    renderWithIntl(<SessionsList initialViews={views(3)} initialCursor={null} planState={null} />);
    expect(sentinels()).toHaveLength(0);
  });

  it('appends the next page, carrying the FILTER with the cursor', async () => {
    loadMoreSessionsAction.mockResolvedValue({ views: views(2, 3), nextCursor: null });
    renderWithIntl(<SessionsList initialViews={views(3)} initialCursor="cur_1" planState="none" />);

    await fireSentinel();

    expect(loadMoreSessionsAction).toHaveBeenCalledWith('cur_1', 'none');
    expect(rowIds()).toEqual(['s_0', 's_1', 's_2', 's_3', 's_4']);
  });

  it('ignores a non-intersecting callback', async () => {
    renderWithIntl(<SessionsList initialViews={views(1)} initialCursor="cur_1" planState={null} />);
    const io = sentinels().at(-1)!;
    await act(async () => {
      io.cb([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(loadMoreSessionsAction).not.toHaveBeenCalled();
  });

  it('does not list a PINNED landing row twice when its own page arrives', async () => {
    // `/plans?session=s_9` pinned s_9 to the top of the first page.
    const pinned = [...views(1, 9), ...views(2)];
    loadMoreSessionsAction.mockResolvedValue({ views: views(2, 8), nextCursor: null });
    renderWithIntl(
      <SessionsList
        initialViews={pinned}
        initialCursor="cur_1"
        planState={null}
        highlightId="s_9"
      />,
    );

    await fireSentinel();

    expect(rowIds()).toEqual(['s_9', 's_0', 's_1', 's_8']);
  });
});

describe('a FAILED page says so, and Retry re-runs the same cursor (§19.5 panel 8)', () => {
  it('shows the error line and a Retry control, then recovers', async () => {
    loadMoreSessionsAction.mockRejectedValueOnce(new Error('boom'));
    renderWithIntl(<SessionsList initialViews={views(2)} initialCursor="cur_1" planState={null} />);
    const armedBefore = sentinels().length;

    await fireSentinel();

    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load more conversations.');
    // No observer is RE-ARMED while the page waits on Retry — it must not retry
    // a broken page on its own in a loop.
    expect(sentinels().length).toBe(armedBefore);

    loadMoreSessionsAction.mockResolvedValueOnce({ views: views(1, 2), nextCursor: null });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(loadMoreSessionsAction).toHaveBeenLastCalledWith('cur_1', null);
    expect(loadMoreSessionsAction).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rowIds()).toEqual(['s_0', 's_1', 's_2']);
  });
});

describe('the `?session=` landing', () => {
  it('highlights that row and scrolls it into view once', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderWithIntl(
      <SessionsList
        initialViews={views(3)}
        initialCursor={null}
        planState={null}
        highlightId="s_1"
      />,
    );

    const row = document.querySelector('[data-session-row="s_1"] > div')!;
    expect(row.className).toContain('bg-(--el-selection-bg)');
    expect(row.className).toContain('border-(--el-accent)');
    expect(document.querySelector('[data-session-row="s_0"] > div')!.className).toContain(
      'bg-(--el-surface)',
    );
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('scrolls nothing without a landing', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderWithIntl(<SessionsList initialViews={views(2)} initialCursor={null} planState={null} />);
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe('the guarded dereference (MOTIR-3241)', () => {
  it('renders nothing for an out-of-range slot instead of throwing', () => {
    forceRange.value = [0, 5];
    renderWithIntl(<SessionsList initialViews={views(2)} initialCursor={null} planState={null} />);
    expect(rowIds()).toEqual(['s_0', 's_1']);
  });
});
