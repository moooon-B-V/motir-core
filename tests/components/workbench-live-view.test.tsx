// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { HomeTabCountsDto, HomeWorkItemRowDto } from '@/lib/dto/home';
import type { WorkbenchWindowDto } from '@/lib/dto/workbench';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { LiveSignalListener, LiveSignalSource } from '@/lib/live/liveSignal';
import { createLiveFlag } from '@/lib/live/liveFlag';
import type { WorkbenchTab } from '@/lib/workbench/tab';

// THE WORKBENCH, APPLIED IN PLACE (Story MOTIR-8539 · Subtask MOTIR-8574).
//
// A nudge used to refresh the whole route. Now the view holds its own state and a
// signal on the workbench topic is ONE read of `GET /api/workbench/window`, whose
// rows and counts land together, merged by identity. Every assertion here is about
// what the reader would SEE change — or, mostly, not change.

const { refresh, push } = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=todo'),
}));

const { WorkbenchLiveView } =
  await import('../../app/(authed)/workbench/_components/WorkbenchLiveView');
const { toWorkbenchRowViews } =
  await import('../../app/(authed)/workbench/_components/workbenchRows');
const { LiveSignalProvider } = await import('@/lib/live/liveSignal');
const { WORKBENCH_WINDOW_PATH } = await import('@/lib/workbench/windowClient');

const EMPTY = <p>Nothing to do</p>;

const MEMBERS: WorkspaceMemberDTO[] = [
  {
    userId: 'u1',
    name: 'Zhu Yue',
    email: 'yue@example.com',
    workspaceRole: 'manager',
    customRole: null,
  },
];

const WORKFLOW = {
  statuses: [
    { key: 'todo', label: 'To Do', category: 'todo' },
    { key: 'in_progress', label: 'In Progress', category: 'in_progress' },
    { key: 'done', label: 'Done', category: 'done' },
  ],
} as unknown as WorkflowDto;

function dto(identifier: string, title: string): HomeWorkItemRowDto {
  return {
    id: `wi_${identifier}`,
    identifier,
    kind: 'task',
    type: null,
    key: Number(identifier.split('-')[1]),
    title,
    status: 'todo',
    ciState: null,
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    executor: null,
    storyPoints: null,
    estimateMinutes: null,
    updatedAt: '2026-10-14T00:00:00.000Z',
    completedAt: null,
    fixReason: null,
    fixDetail: null,
    project: { id: 'p1', identifier: 'MOTIR', name: 'Motir' },
    viewerIsAssignee: true,
    viewerIsReporter: true,
    canContinueHosted: false,
    fixGroupKind: null,
    fixMembers: [],
    resumeState: null,
    resumeRunId: null,
    resumeMembers: [],
    groupHead: null,
    groupMembers: [],
    canFixHosted: false,
    repairRun: null,
  };
}

function counts(over: Partial<HomeTabCountsDto> = {}): HomeTabCountsDto {
  return {
    myWork: 0,
    toDo: 0,
    inProgress: 0,
    toFix: 0,
    toResume: 0,
    recentlyFinished: 0,
    watching: 0,
    approvals: 0,
    planning: 0,
    ...over,
  };
}

/** A window answer for `items` on `tab`, as the endpoint would send it. */
function answer(
  items: HomeWorkItemRowDto[],
  strip: HomeTabCountsDto,
  tab: WorkbenchTab = 'todo',
): WorkbenchWindowDto {
  return {
    tab,
    window: {
      kind: 'workItems',
      page: { items, total: items.length, page: 1, pageSize: 25 },
      members: MEMBERS,
      workflow: WORKFLOW,
    },
    counts: strip,
    readAt: new Date().toISOString(),
  } as unknown as WorkbenchWindowDto;
}

/** A source the test fires by hand — the seam's contract, nothing else. */
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
    fire() {
      seq += 1;
      for (const l of [...listeners]) l({ topic: { kind: 'workbench' }, seq, moved: ['toDo'] });
    },
  };
}

/**
 * `fetch` answering the window path from a queue the test controls: each read
 * waits until the test releases it with an answer (or a failure).
 */
function windowFetch() {
  const urls: string[] = [];
  const pending: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      return new Promise<Response>((resolve, reject) => {
        pending.push({ resolve, reject });
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }),
  );
  return {
    reads: () => urls.filter((u) => u.includes(WORKBENCH_WINDOW_PATH)),
    async release(body: WorkbenchWindowDto) {
      await act(async () => {
        pending.shift()?.resolve(Response.json(body));
      });
      await act(async () => {});
    },
    async fail() {
      await act(async () => {
        pending.shift()?.resolve(new Response('nope', { status: 500 }));
      });
      await act(async () => {});
    },
  };
}

const START = [dto('MOTIR-1', 'First card'), dto('MOTIR-2', 'Second card')];

function View({
  tab = 'todo',
  page = 1,
  items = START,
  strip = counts({ toDo: 2 }),
}: {
  tab?: WorkbenchTab;
  page?: number;
  items?: HomeWorkItemRowDto[];
  strip?: HomeTabCountsDto;
}) {
  return (
    <WorkbenchLiveView
      tab={tab}
      page={page}
      rows={toWorkbenchRowViews(items, WORKFLOW, MEMBERS, false)}
      pagination={{ total: items.length, page, pageSize: 25 }}
      planningSessions={[]}
      counts={strip}
      label="To do"
      empty={EMPTY}
      viewerId="u1"
    />
  );
}

function mount(fake: ReturnType<typeof fakeSource>, view: ReactNode = <View />) {
  const wrap = (node: ReactNode) => (
    <LiveSignalProvider source={fake.source}>{node}</LiveSignalProvider>
  );
  const utils = renderWithIntl(wrap(view));
  return { ...utils, rerender: (node: ReactNode) => utils.rerender(wrap(node)) };
}

const toDoCount = () => screen.getByTestId('workbench-tab-todo').textContent;

beforeEach(() => {
  refresh.mockClear();
  push.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a signal is ONE window read, never a refresh', () => {
  it('reads the current tab and page once, and does not touch the route', async () => {
    const fake = fakeSource();
    const net = windowFetch();
    mount(fake);

    await act(async () => fake.fire());
    expect(net.reads()).toEqual([`${WORKBENCH_WINDOW_PATH}?tab=todo`]);
    await net.release(answer(START, counts({ toDo: 2 })));

    expect(refresh).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('ten signals during one read cost exactly one more read after it settles', async () => {
    const fake = fakeSource();
    const net = windowFetch();
    mount(fake);

    await act(async () => fake.fire());
    await act(async () => {
      for (let i = 0; i < 10; i += 1) fake.fire();
    });
    expect(net.reads()).toHaveLength(1);

    await net.release(answer(START, counts({ toDo: 2 })));
    expect(net.reads()).toHaveLength(2);
    await net.release(answer(START, counts({ toDo: 2 })));
    expect(net.reads()).toHaveLength(2);
  });

  it('a failed read keeps what is on screen and the next signal reads again', async () => {
    const fake = fakeSource();
    const net = windowFetch();
    mount(fake);

    await act(async () => fake.fire());
    await net.fail();
    expect(screen.getByText('First card')).toBeTruthy();
    expect(toDoCount()).toContain('2');

    await act(async () => fake.fire());
    expect(net.reads()).toHaveLength(2);
  });
});

describe('rows and counts land together', () => {
  it('a row arriving on To do and the To do count rising arrive in the same update', async () => {
    const fake = fakeSource();
    const net = windowFetch();
    mount(fake);
    expect(toDoCount()).toContain('2');

    await act(async () => fake.fire());
    await net.release(answer([dto('MOTIR-3', 'Just arrived'), ...START], counts({ toDo: 3 })));

    expect(screen.getByText('Just arrived')).toBeTruthy();
    expect(toDoCount()).toContain('3');
  });

  it('a row leaving To do drops the count in the same update, and the row is held (§ 26)', async () => {
    const fake = fakeSource();
    const net = windowFetch();
    mount(fake);

    await act(async () => fake.fire());
    await net.release(answer([START[1]!], counts({ toDo: 1, inProgress: 1 })));

    // The held-row rule is the list's, unchanged by MOTIR-8574: the row stays in
    // place until the next load, while the strip has already moved.
    expect(screen.getByText('First card')).toBeTruthy();
    expect(toDoCount()).toContain('1');
    expect(screen.getByTestId('workbench-tab-in-progress').textContent).toContain('1');
  });
});

describe('an equal answer changes nothing; a changed row changes that row only', () => {
  it('an identical answer leaves the list DOM untouched', async () => {
    const fake = fakeSource();
    const net = windowFetch();
    const { container } = mount(fake);

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    await act(async () => fake.fire());
    await net.release(answer(START, counts({ toDo: 2 })));
    await act(async () => {});
    observer.disconnect();
    expect(mutations).toHaveLength(0);
  });

  it('a renamed row re-renders inside that row and nowhere else', async () => {
    const fake = fakeSource();
    const net = windowFetch();
    const { container } = mount(fake);
    const untouched = screen.getByTestId('workbench-row-MOTIR-2');
    const renamed = screen.getByTestId('workbench-row-MOTIR-1');

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    await act(async () => fake.fire());
    await net.release(
      answer([dto('MOTIR-1', 'First card, renamed'), START[1]!], counts({ toDo: 2 })),
    );
    observer.disconnect();

    expect(screen.getByText('First card, renamed')).toBeTruthy();
    expect(mutations.length).toBeGreaterThan(0);
    for (const m of mutations) {
      expect(renamed.contains(m.target)).toBe(true);
      expect(untouched.contains(m.target)).toBe(false);
    }
  });
});

describe('an answer for a view the reader has left is dropped', () => {
  it('drops a read issued on To do once the reader is on In progress', async () => {
    const fake = fakeSource();
    const net = windowFetch();
    const { rerender } = mount(fake);

    await act(async () => fake.fire());
    rerender(<View tab="in-progress" items={[dto('MOTIR-9', 'Moving card')]} />);
    await net.release(answer([dto('MOTIR-5', 'Stale to-do card')], counts({ toDo: 9 })));

    expect(screen.queryByText('Stale to-do card')).toBeNull();
    expect(screen.getByText('Moving card')).toBeTruthy();
  });

  it('drops an answer that names another tab', async () => {
    const fake = fakeSource();
    const net = windowFetch();
    mount(fake);

    await act(async () => fake.fire());
    await net.release(answer([dto('MOTIR-7', 'Not this tab')], counts({ toDo: 9 }), 'watching'));

    expect(screen.queryByText('Not this tab')).toBeNull();
    expect(toDoCount()).toContain('2');
  });
});

describe('what the reader is doing survives an applied read', () => {
  it('keeps focus on the row link it was on', async () => {
    const fake = fakeSource();
    const net = windowFetch();
    mount(fake);
    const link = screen.getByTestId('workbench-row-MOTIR-2').querySelector('a');
    expect(link).toBeTruthy();
    link!.focus();
    expect(document.activeElement).toBe(link);

    await act(async () => fake.fire());
    await net.release(answer([dto('MOTIR-3', 'Arrived'), ...START], counts({ toDo: 3 })));

    expect(screen.getByText('Arrived')).toBeTruthy();
    expect(document.activeElement).toBe(link);
  });
});
