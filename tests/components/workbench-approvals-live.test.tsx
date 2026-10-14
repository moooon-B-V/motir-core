// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { ApprovalQueueRowDto } from '@/lib/dto/approvalGate';
import type { HomeTabCountsDto } from '@/lib/dto/home';
import type { WorkbenchWindowDto } from '@/lib/dto/workbench';
import type { LiveSignalListener, LiveSignalSource } from '@/lib/live/liveSignal';
import { createLiveFlag } from '@/lib/live/liveFlag';

// TO APPROVE, APPLIED IN PLACE (Story MOTIR-8539 · Subtask MOTIR-8581).
//
// The tab's rows used to be a server body that only a route refresh could change.
// Now a `workbench` signal is ONE read of `GET /api/workbench/window?tab=approvals`
// through the view's hook; the queue it carries reaches the list through the
// tab-window context and the count reaches the strip — in the same update.

const { refresh, push, shallowPush } = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  shallowPush: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=approvals'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { WorkbenchLiveView } =
  await import('../../app/(authed)/workbench/_components/WorkbenchLiveView');
const { ApprovalsList } = await import('../../app/(authed)/workbench/_components/ApprovalsList');
const { LiveSignalProvider } = await import('@/lib/live/liveSignal');
const { WORKBENCH_WINDOW_PATH } = await import('@/lib/workbench/windowClient');
const { approvalsWindowAnswer, ZERO_COUNTS } = await import('../helpers/workbenchTabWindow');

const EMPTY = <p>Nothing is waiting</p>;

function gate(n: number, title = `Design ${n}`): ApprovalQueueRowDto {
  return {
    gateId: `gate-${n}`,
    kind: 'design_result',
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Mara S.',
    waitingSince: '2026-10-10T00:00:00.000Z',
    workItem: {
      id: `wi-${n}`,
      key: 5100 + n,
      identifier: `MOTIR-${5100 + n}`,
      title,
      kind: 'subtask',
      type: 'design',
    },
    subject: {
      kind: 'design_result',
      designEvidenceId: `ev-${n}`,
      producedByKey: `MOTIR-${5100 + n}`,
      commitSha: '9840d00ea1b2',
      assetCount: 3,
      noteExcerpt: 'The row opens the overlay.',
    },
  };
}

const counts = (approvals: number): HomeTabCountsDto => ({ ...ZERO_COUNTS, approvals });

const queueOf = (items: ApprovalQueueRowDto[]) => ({
  items,
  total: items.length,
  truncated: false,
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

const START = [gate(1), gate(2)];

function mount(fake: ReturnType<typeof fakeSource>, rows = START) {
  const wrap = (node: ReactNode) => (
    <LiveSignalProvider source={fake.source}>{node}</LiveSignalProvider>
  );
  return renderWithIntl(
    wrap(
      <WorkbenchLiveView
        tab="approvals"
        page={1}
        rows={[]}
        pagination={{ total: 0, page: 1, pageSize: 25 }}
        planningSessions={[]}
        counts={counts(rows.length)}
        label="To approve"
        empty={EMPTY}
        viewerId="u1"
      >
        {/* What `<ApprovalsTab>` renders inside the page's `<Suspense>`. */}
        <ApprovalsList rows={rows} label="To approve" ceiling={null} empty={EMPTY} />
      </WorkbenchLiveView>,
    ),
  );
}

const approvalsCount = () => screen.getByTestId('workbench-tab-approvals').textContent;
const rowIds = () => screen.getAllByTestId(/^approval-row-gate-/).map((el) => el.dataset['testid']);

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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('To approve — a signal is ONE window read, never a refresh', () => {
  it('reads `?tab=approvals` once and does not touch the route', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);

    await fake.fire();
    expect(net.reads()).toEqual([`${WORKBENCH_WINDOW_PATH}?tab=approvals`]);
    await net.release(approvalsWindowAnswer(queueOf(START), counts(2)));
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('To approve — rows and counts land together', () => {
  it('a gate that arrives appears, marked New, as the count rises', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);
    expect(approvalsCount()).toContain('2');

    await fake.fire();
    await net.release(approvalsWindowAnswer(queueOf([gate(3), ...START]), counts(3)));

    // Where it lands is `useLiveRows`' rule (§ 26), unchanged; that it lands is this card's.
    expect([...rowIds()].sort()).toEqual([
      'approval-row-gate-1',
      'approval-row-gate-2',
      'approval-row-gate-3',
    ]);
    expect(screen.getByTestId('approval-row-gate-3').textContent).toContain('New');
    expect(approvalsCount()).toContain('3');
  });

  it('a gate that leaves is HELD in place as the count drops (§ 26)', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);

    await fake.fire();
    await net.release(approvalsWindowAnswer(queueOf([START[1]!]), counts(1)));

    // Still on screen — a row somebody else decided is never removed under the reader.
    expect(rowIds()).toEqual(['approval-row-gate-1', 'approval-row-gate-2']);
    expect(approvalsCount()).toContain('1');
    expect(approvalsCount()).not.toContain('2');
  });

  it('a changed gate re-renders its own row and leaves its sibling untouched', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);
    const first = screen.getByTestId('approval-row-gate-1');
    const second = screen.getByTestId('approval-row-gate-2');

    const seen = observe(document.body);
    await fake.fire();
    await net.release(approvalsWindowAnswer(queueOf([gate(1), gate(2, 'Renamed')]), counts(2)));
    seen.stop();

    expect(screen.getByText('Renamed')).toBeTruthy();
    expect(screen.getByTestId('approval-row-gate-1')).toBe(first);
    expect(seen.records.length).toBeGreaterThan(0);
    for (const record of seen.records) {
      expect(first.contains(record.target)).toBe(false);
      expect(second.contains(record.target)).toBe(true);
    }
  });
});

describe('To approve — an unchanged answer changes nothing', () => {
  it('mutates no DOM at all', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);

    const seen = observe(document.body);
    await fake.fire();
    await net.release(approvalsWindowAnswer(queueOf([gate(1), gate(2)]), counts(2)));
    seen.stop();
    expect(seen.records).toHaveLength(0);
  });
});

describe('To approve — the ceiling line follows the read', () => {
  it('a read the ceiling cut draws the line, with the true total beside it', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mount(fake);
    expect(screen.queryByRole('note')).toBeNull();

    await fake.fire();
    await net.release(
      approvalsWindowAnswer({ items: START, total: 9, truncated: true }, counts(9)),
    );

    expect(screen.getByRole('note').textContent).toContain('9');
    expect(approvalsCount()).toContain('9');
  });
});
