// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { WorkbenchPlanningPageDto, WorkbenchPlanningRowDto } from '@/lib/dto/home';
import type { PlanProgressSnapshot } from '@/lib/plans/planProgress';

// THE PLANNING TAB'S LIVE ISLAND — the poll's remaining arms (Story MOTIR-7820 ·
// MOTIR-7832, the story's coverage floor). `workbench-planning-tab.test.tsx`
// (MOTIR-7831) proves the island's behaviour; these are the arms of
// `PlanningList.tsx` it leaves unreached, each a real thing the network or the
// document can do:
//   · a read that ANSWERS but not 200 — a dropped read like a rejected one;
//   · an outcome read that finds the plan STILL generating — nothing recorded;
//   · a row held across two polls — its outcome is read ONCE, not per poll;
//   · a failure that lands after a newer read was applied — it says nothing;
//   · a `visibilitychange` to HIDDEN — no read;
//   · leaving the tab with a read in flight — the read is aborted;
// `PlanningRow`'s title door (a plain click opens the target's quick view), and
// `planningOutcomeOf`'s one unread arm, a plan APPROVED between two polls.
//
// The island's own unreachable arms are named in `vitest.coverage.plan-progress.config.ts`.

const { push, refresh, shallowPush } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  shallowPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push, prefetch: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=planning'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { PlanningList } = await import('../../app/(authed)/workbench/_components/PlanningList');
const { planningOutcomeOf } =
  await import('../../app/(authed)/workbench/_components/planningOutcome');
const { PLANNING_TAB_CEILING } = await import('@/lib/services/workbenchPlanningService');

const T0 = Date.parse('2026-10-08T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function progress(): PlanProgressSnapshot {
  return {
    startedAt: iso(T0 - 180_000),
    lastActivityAt: iso(T0 - 5_000),
    observedAt: iso(T0),
    authored: 1,
    proposed: 5,
    steps: [],
  };
}

function row(planId: string): WorkbenchPlanningRowDto {
  return {
    planId,
    sessionId: `sess-${planId}`,
    title: null,
    projectName: 'Acme Web',
    targets: [{ key: 'ACME-12', title: 'Per-key API quotas' }],
    author: { source: 'native', harness: null, model: null, origin: 'user' },
    createdAt: iso(T0 - 180_000),
    progress: progress(),
  };
}

function page(items: WorkbenchPlanningRowDto[], total = items.length): WorkbenchPlanningPageDto {
  return { items, total, page: 1, pageSize: PLANNING_TAB_CEILING };
}

function mount(seed: WorkbenchPlanningPageDto) {
  return renderWithIntl(
    <PlanningList
      seed={seed}
      projectName="Acme Web"
      label="Planning"
      empty={<p>No plans being written</p>}
    />,
    { locale: 'en', messages: en },
  );
}

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

async function poll(times = 1) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await act(async () => {});
  }
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PlanningList — the poll’s remaining arms', () => {
  it('a read that answers 500 is a dropped read: the rows stand, and three say so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'INTERNAL' }, 500)),
    );
    mount(page([row('p1')]));

    await poll(2);
    expect(screen.getByTestId('plan-progress-compact').textContent).not.toContain('Reconnecting');
    await poll();
    expect(screen.getByTestId('plan-progress-compact').textContent).toContain('Reconnecting');
    expect(screen.getByTestId('planning-row-p1')).toBeTruthy();
  });

  it('a held row whose plan is STILL generating records no outcome, and is asked about ONCE', async () => {
    const fetchMock = vi.fn(async (input: string) =>
      String(input) === '/api/plans/p1'
        ? json({ status: 'generating', decisionReason: null })
        : json(page([row('p2')], 1)),
    );
    vi.stubGlobal('fetch', fetchMock);
    mount(page([row('p1'), row('p2')], 2));

    await poll(2);
    const held = screen.getByTestId('planning-row-p1');
    expect(held.dataset['held']).toBe('true');
    // Absent from one window, not finished: no outcome is RECORDED for it, so it
    // never claims the plan was written.
    expect(held.textContent).not.toContain('Written');
    // Two polls held it; the plan was read once.
    const planReads = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/plans/p1');
    expect(planReads).toHaveLength(1);
  });

  it('a failure that lands AFTER a newer read was applied says nothing about now', async () => {
    let fail: ((err: Error) => void) | null = null;
    const slow = new Promise<never>((_, reject) => {
      fail = reject;
    });
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) return slow;
        return json(page([row('p1')], 1));
      }),
    );
    mount(page([row('p1')], 1));

    await poll(); // read 1, still in flight
    await poll(); // read 2, applied
    await act(async () => {
      fail?.(new Error('offline'));
    });
    await act(async () => {});
    await poll(2); // two more successes — a counted stale failure would make three
    expect(screen.getByTestId('plan-progress-compact').textContent).not.toContain('Reconnecting');
  });

  it('a `visibilitychange` to HIDDEN starts no read', async () => {
    const fetchMock = vi.fn(async () => json(page([row('p1')], 1)));
    vi.stubGlobal('fetch', fetchMock);
    mount(page([row('p1')], 1));

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    visibility.mockRestore();
  });

  it('leaving the tab with a read in flight aborts it, and its late answer changes nothing', async () => {
    let resolve: ((res: Response) => void) | null = null;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((r) => {
          resolve = r;
        });
      }),
    );
    const view = mount(page([row('p1')], 1));

    await poll();
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      resolve?.(json(page([row('p1'), row('p2')], 2)));
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('PlanningRow — the title door', () => {
  it('a plain click on a TARGETED title opens that item’s quick view over the tab', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(page([row('p1')], 1))),
    );
    mount(page([row('p1')], 1));

    const title = screen.getByRole('link', { name: 'Per-key API quotas' });
    fireEvent.click(title);
    expect(shallowPush).toHaveBeenCalledWith('/workbench?tab=planning&peek=ACME-12');
  });
});

describe('planningOutcomeOf — the arm the island’s suite leaves unread', () => {
  it('a plan APPROVED between two polls is still the written outcome, with the approved door', () => {
    expect(planningOutcomeOf({ status: 'approved', decisionReason: null })).toEqual({
      chipKey: 'planned',
      lineKey: 'plannedLine',
      planStatus: 'approved',
    });
  });
});
