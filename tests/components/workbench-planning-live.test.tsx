// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { HomeTabCountsDto, WorkbenchPlanningRowDto } from '@/lib/dto/home';
import type { WorkbenchWindowDto } from '@/lib/dto/workbench';
import type { LiveSignalListener, LiveSignalSource } from '@/lib/live/liveSignal';
import { createLiveFlag } from '@/lib/live/liveFlag';

// PLANNING, APPLIED IN PLACE (Story MOTIR-8539 · Subtask MOTIR-8581).
//
// The tab's list used to poll `/api/workbench/planning` on its own and ask for a
// route refresh whenever the set's size moved, so the strip's count could only
// follow its rows by a whole page render. Now a `workbench` signal — and the tab's
// own 10s tick — is ONE read of `GET /api/workbench/window?tab=planning` through
// the view's hook; the page it carries reaches the list and the count reaches the
// strip in the same update, and nothing refreshes.

const { refresh, push, shallowPush } = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  shallowPush: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=planning'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { WorkbenchLiveView } =
  await import('../../app/(authed)/workbench/_components/WorkbenchLiveView');
const { PlanningList } = await import('../../app/(authed)/workbench/_components/PlanningList');
const { LiveSignalProvider } = await import('@/lib/live/liveSignal');
const { WORKBENCH_WINDOW_PATH } = await import('@/lib/workbench/windowClient');
const { planningWindowAnswer, ZERO_COUNTS } = await import('../helpers/workbenchTabWindow');

const EMPTY = <p>No plans being written</p>;

const T0 = Date.parse('2026-10-08T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function plan(planId: string, target = `Target of ${planId}`): WorkbenchPlanningRowDto {
  return {
    planId,
    sessionId: `sess-${planId}`,
    title: null,
    projectName: 'Acme Web',
    targets: [{ key: 'ACME-12', title: target }],
    author: { source: 'native', harness: null, model: null, origin: 'user' },
    createdAt: iso(T0 - 180_000),
    progress: {
      startedAt: iso(T0 - 180_000),
      lastActivityAt: iso(T0 - 5_000),
      observedAt: iso(T0),
      authored: 1,
      proposed: 5,
      autoResume: null,
      steps: [],
    },
  };
}

const counts = (planning: number): HomeTabCountsDto => ({ ...ZERO_COUNTS, planning });

const pageOf = (items: WorkbenchPlanningRowDto[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 50,
});

function fakeSource() {
  const listeners = new Set<LiveSignalListener>();
  let seq = 0;
  const source: LiveSignalSource = {
    subscribe(topic, onSignal) {
      if (topic.kind !== 'workbench') return () => {};
      listeners.add(onSignal);
      return () => listeners.delete(onSignal);
    },
    reconnecting: createLiveFlag(false),
  };
  return {
    source,
    async fire() {
      seq += 1;
      await act(async () => {
        for (const l of [...listeners]) l({ topic: { kind: 'workbench' }, seq, moved: [] });
      });
    },
  };
}

/** `fetch` that answers each window read with the next body the test releases. */
function windowFetch() {
  const urls: string[] = [];
  const pending: ((r: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      urls.push(String(input));
      // A held row's outcome read — the plan was written.
      if (String(input).startsWith('/api/plans/')) {
        return Promise.resolve(Response.json({ status: 'planned', decisionReason: null }));
      }
      return new Promise<Response>((resolve) => pending.push(resolve));
    }),
  );
  return {
    reads: () => urls.filter((u) => u.includes(WORKBENCH_WINDOW_PATH)),
    async release(body: WorkbenchWindowDto) {
      await act(async () => {
        pending.shift()?.(Response.json(body));
      });
      await act(async () => {});
    },
  };
}

const START = [plan('p1'), plan('p2')];

function mount(fake: ReturnType<typeof fakeSource>, rows = START) {
  const wrap = (node: ReactNode) => (
    <LiveSignalProvider source={fake.source}>{node}</LiveSignalProvider>
  );
  return renderWithIntl(
    wrap(
      <WorkbenchLiveView
        tab="planning"
        page={1}
        rows={[]}
        pagination={{ total: 0, page: 1, pageSize: 25 }}
        planningSessions={[]}
        counts={counts(rows.length)}
        label="Planning"
        empty={EMPTY}
        viewerId="u1"
      >
        {/* What `<PlanningTab>` renders inside the page's `<Suspense>`. */}
        <PlanningList seed={pageOf(rows)} projectName="Acme Web" label="Planning" empty={EMPTY} />
      </WorkbenchLiveView>,
    ),
  );
}

const planningCount = () => screen.getByTestId('workbench-tab-planning').textContent;
const rowIds = () => screen.getAllByTestId(/^planning-row-/).map((el) => el.dataset['testid']);

function observe(target: Node) {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((r) => records.push(...r));
  observer.observe(target, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return {
    records,
    stop: () => {
      records.push(...observer.takeRecords());
      observer.disconnect();
    },
  };
}

beforeEach(() => {
  refresh.mockClear();
  push.mockClear();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Planning — a signal is ONE window read, never a refresh', () => {
  it('reads `?tab=planning` once and does not touch the route', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);

    await fake.fire();
    expect(net.reads()).toEqual([`${WORKBENCH_WINDOW_PATH}?tab=planning`]);
    await net.release(planningWindowAnswer(pageOf(START), counts(2)));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the tab’s own 10s tick is the same read, and a signal during it starts no second', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await fake.fire();
    expect(net.reads()).toEqual([`${WORKBENCH_WINDOW_PATH}?tab=planning`]);
    await net.release(planningWindowAnswer(pageOf(START), counts(2)));
    // The signal that came in during the read is answered by exactly one more.
    expect(net.reads()).toHaveLength(2);
    await net.release(planningWindowAnswer(pageOf(START), counts(2)));
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('Planning — rows and counts land together', () => {
  it('a plan that arrives appears at the top, marked New, as the count rises', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);
    expect(planningCount()).toContain('2');

    await fake.fire();
    await net.release(planningWindowAnswer(pageOf([plan('p3'), ...START]), counts(3)));

    expect(rowIds()).toEqual(['planning-row-p3', 'planning-row-p1', 'planning-row-p2']);
    expect(screen.getByTestId('planning-row-p3').textContent).toContain('New');
    expect(planningCount()).toContain('3');
  });

  it('a plan that leaves is HELD in place with its outcome as the count drops (§ 36.8)', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);

    await fake.fire();
    await net.release(planningWindowAnswer(pageOf([START[1]!]), counts(1)));
    await act(async () => {});

    expect(rowIds()).toEqual(['planning-row-p1', 'planning-row-p2']);
    expect(screen.getByTestId('planning-row-p1').dataset['held']).toBe('true');
    expect(planningCount()).toContain('1');
    expect(planningCount()).not.toContain('2');
  });

  it('a changed plan re-renders its own row and leaves its sibling untouched', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);
    const first = screen.getByTestId('planning-row-p1');
    const second = screen.getByTestId('planning-row-p2');

    const seen = observe(document.body);
    await fake.fire();
    await net.release(planningWindowAnswer(pageOf([plan('p1'), plan('p2', 'Renamed')]), counts(2)));
    seen.stop();

    expect(second.textContent).toContain('Renamed');
    expect(screen.getByTestId('planning-row-p1')).toBe(first);
    expect(seen.records.length).toBeGreaterThan(0);
    for (const record of seen.records) {
      expect(first.contains(record.target)).toBe(false);
      expect(second.contains(record.target)).toBe(true);
    }
  });
});

describe('Planning — an unchanged answer changes nothing', () => {
  it('mutates no DOM at all', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);

    const seen = observe(document.body);
    await fake.fire();
    await net.release(planningWindowAnswer(pageOf([plan('p1'), plan('p2')]), counts(2)));
    seen.stop();
    expect(seen.records).toHaveLength(0);
  });
});
