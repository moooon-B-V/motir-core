// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { HomeTabCountsDto, HomeWorkItemRowDto } from '@/lib/dto/home';
import type { WorkbenchWindowDto } from '@/lib/dto/workbench';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { LiveSignalListener, LiveSignalSource } from '@/lib/live/liveSignal';
import { createLiveFlag } from '@/lib/live/liveFlag';
import type { WorkbenchTab } from '@/lib/workbench/tab';

// APPROVE BRINGS THE WORKBENCH CURRENT WITHOUT A ROUTE REFRESH (Story MOTIR-8539 ·
// Subtask MOTIR-8576).
//
// The planning overlay is mounted in the shell beside the page, not inside the
// Workbench view, so its approve reaches the view through the shell's reread slot
// (`lib/workbench/workbenchReread.ts`): the view registers its `reread`, the
// overlay's hosts call `useRequestWorkbenchReread()`. That request is the view's
// own one-in-flight window read, so an approve and a stream nudge collapse, and
// what the reader sees when the overlay closes is exactly that response.
//
// `Approver` stands in for the overlay's host — it is a sibling of the page under
// the same shell, and it calls the same hook `PlanWorkspaceHost`'s `onApproved`
// does (`planning-workspace-host.test.tsx` pins that call).

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
const { WorkbenchRereadProvider, useRequestWorkbenchReread } =
  await import('@/lib/workbench/workbenchReread');
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

function Approver() {
  const requestWorkbenchReread = useRequestWorkbenchReread();
  return (
    <button type="button" onClick={requestWorkbenchReread}>
      Approve changes
    </button>
  );
}

function mountShell(fake: ReturnType<typeof fakeSource>) {
  return renderWithIntl(
    <LiveSignalProvider source={fake.source}>
      <WorkbenchRereadProvider>
        <WorkbenchLiveView
          tab="todo"
          page={1}
          rows={toWorkbenchRowViews(START, WORKFLOW, MEMBERS, false)}
          pagination={{ total: START.length, page: 1, pageSize: 25 }}
          planningSessions={[]}
          counts={counts({ toDo: 2 })}
          label="To do"
          empty={EMPTY}
          viewerId="u1"
        />
        <Approver />
      </WorkbenchRereadProvider>
    </LiveSignalProvider>,
  );
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

describe('an approve over a mounted Workbench is ONE window read, never a refresh', () => {
  it('reads the current tab and page once, and the strip and rows are that response', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mountShell(fake);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve changes' }));
    });
    expect(net.reads()).toEqual([`${WORKBENCH_WINDOW_PATH}?tab=todo`]);

    await net.release(
      answer([dto('MOTIR-3', 'Created by the plan'), ...START], counts({ toDo: 3 })),
    );
    expect(screen.getByText('Created by the plan')).toBeTruthy();
    expect(toDoCount()).toContain('3');
    expect(refresh).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('a stream nudge during that read starts no second concurrent read', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    mountShell(fake);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve changes' }));
    });
    act(() => fake.fire());
    expect(net.reads()).toHaveLength(1);

    // It is answered by exactly ONE read after the approve's settles.
    await net.release(answer(START, counts({ toDo: 2 })));
    expect(net.reads()).toHaveLength(2);
    await net.release(answer(START, counts({ toDo: 2 })));
    expect(net.reads()).toHaveLength(2);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a request after the view has unmounted reads nothing and throws nothing', async () => {
    const net = windowFetch();
    const fake = fakeSource();
    const view = mountShell(fake);
    view.rerender(
      <LiveSignalProvider source={fake.source}>
        <WorkbenchRereadProvider>
          <Approver />
        </WorkbenchRereadProvider>
      </LiveSignalProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve changes' }));
    });
    expect(net.reads()).toHaveLength(0);
  });
});

describe('outside any provider the request is the QUIET default', () => {
  it('is a no-op and throws nothing', async () => {
    const net = windowFetch();
    renderWithIntl(<Approver />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve changes' }));
    });
    expect(net.reads()).toHaveLength(0);
  });
});
