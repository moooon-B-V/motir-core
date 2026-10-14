// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ToResumePlanningSessionDto } from '@/lib/dto/home';
import type { LiveSignal } from '@/lib/live/liveSignal';
import { NEVER_RECONNECTING } from '@/lib/live/liveFlag';
import { LiveSignalProvider } from '@/lib/live/liveSignal';
import { fakeLiveSource } from './helpers/fakeLiveSource';
import { POLL_MS, planPollSource } from '@/lib/live/sources/planPollSource';
import { workbenchWindowUrl } from '@/lib/workbench/windowClient';
import {
  WorkbenchRereadProvider,
  useRegisterWorkbenchReread,
  useRequestWorkbenchReread,
} from '@/lib/workbench/workbenchReread';
import { ZERO_COUNTS } from '../helpers/workbenchTabWindow';
import type { WorkbenchRowView } from '../../app/(authed)/workbench/_components/workbenchRows';

// THE STORY'S SEAMS, ARM BY ARM (Story MOTIR-8539 · Subtask MOTIR-8579).
//
// The arms the story gate's coverage run left unread, each a real thing the seam
// can be handed: a second page, a registration that outlived its replacement, a
// plan topic with no listener, a group head whose members moved, a window for the
// other tab, a server render landing on the view a read already owns.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams(),
}));

const { mergeWorkItemContent, workItemContentOf } =
  await import('../../app/(authed)/workbench/_components/WorkbenchLiveView');
const { useWorkbenchWindow } =
  await import('../../app/(authed)/workbench/_components/useWorkbenchWindow');
const { WorkbenchTabWindowContext, useTabWindowContent } =
  await import('../../app/(authed)/workbench/_components/useTabWindowContent');
const { keepIfEqual } = await import('@/lib/workbench/mergeRows');
const { useWorkbenchLiveStream } =
  await import('../../app/(authed)/workbench/_components/useWorkbenchLive');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('windowClient', () => {
  it('names the page only past the first', () => {
    expect(workbenchWindowUrl('todo', 1)).toBe('/api/workbench/window?tab=todo');
    expect(workbenchWindowUrl('todo', 3)).toBe('/api/workbench/window?tab=todo&page=3');
  });
});

describe('the reread slot', () => {
  it('a registration unmounted after its replacement leaves the replacement in place', () => {
    const first = vi.fn();
    const second = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WorkbenchRereadProvider>{children}</WorkbenchRereadProvider>
    );
    const { result, rerender } = renderHook(
      ({ fn }: { fn: () => void }) => {
        useRegisterWorkbenchReread(fn);
        return useRequestWorkbenchReread();
      },
      { wrapper, initialProps: { fn: first } },
    );
    // `second` replaces `first`; the effect cleanup for `first` runs AFTER the
    // registry already holds `second`, and must not clear it.
    rerender({ fn: second });
    act(() => result.current());
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('a view that unmounts after another registered leaves the other registered', () => {
    const first = vi.fn();
    const second = vi.fn();
    let request: () => void = () => {};
    function Register({ fn }: { fn: () => void }) {
      useRegisterWorkbenchReread(fn);
      return null;
    }
    function Requester() {
      request = useRequestWorkbenchReread();
      return null;
    }
    const tree = (both: boolean) => (
      <WorkbenchRereadProvider>
        {both ? <Register fn={first} /> : null}
        <Register fn={second} />
        <Requester />
      </WorkbenchRereadProvider>
    );
    const { rerender } = render(tree(true));
    // `second` registered after `first`; `first` leaving must not clear it.
    rerender(tree(false));
    act(() => request());
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('outside any provider a request does nothing', () => {
    const { result } = renderHook(() => useRequestWorkbenchReread());
    expect(() => result.current()).not.toThrow();
  });
});

describe('liveFlag', () => {
  it('NEVER_RECONNECTING is false and its subscription is inert', () => {
    expect(NEVER_RECONNECTING.get()).toBe(false);
    const off = NEVER_RECONNECTING.subscribe(() => {});
    expect(() => off()).not.toThrow();
  });
});

describe('the plan poll source', () => {
  it('ignores a topic that is not a plan, to subscribe and to trigger', () => {
    const seen: LiveSignal[] = [];
    const off = planPollSource.subscribe({ kind: 'workbench' }, (s) => seen.push(s));
    planPollSource.trigger!({ kind: 'workbench' });
    off();
    expect(seen).toEqual([]);
  });

  it('a trigger for a plan nobody watches reaches nobody', () => {
    expect(() => planPollSource.trigger!({ kind: 'plan', planId: 'nobody' })).not.toThrow();
  });

  it('two subscribers of one plan each tick, and the plan stays watched until the last leaves', () => {
    vi.useFakeTimers();
    const one: LiveSignal[] = [];
    const two: LiveSignal[] = [];
    const topic = { kind: 'plan', planId: 'shared' } as const;
    const offOne = planPollSource.subscribe(topic, (s) => one.push(s));
    const offTwo = planPollSource.subscribe(topic, (s) => two.push(s));
    vi.advanceTimersByTime(POLL_MS);
    expect([one.length, two.length]).toEqual([1, 1]);

    offOne();
    planPollSource.trigger!(topic);
    expect(two.at(-1)!.forced).toBe(true);
    expect(one).toHaveLength(1);
    offTwo();
    planPollSource.trigger!(topic);
    expect(two).toHaveLength(2);
  });
});

const head = (id: string, members: string[] = [], title = id) =>
  ({
    id,
    title,
    groupMembers: members.map((m) => ({ id: m, title: m })),
  }) as unknown as WorkbenchRowView;

const session = (sessionId: string): ToResumePlanningSessionDto =>
  ({ sessionId, title: sessionId }) as unknown as ToResumePlanningSessionDto;

describe('mergeWorkItemContent', () => {
  const pagination = { total: 2, page: 1, pageSize: 25 };

  it('a group head whose members did not change keeps its object', () => {
    const prev = { rows: [head('a', ['m1', 'm2'])], pagination, planningSessions: [] };
    const next = {
      rows: [head('a', ['m1', 'm2'])],
      pagination: { ...pagination },
      planningSessions: [],
    };
    expect(mergeWorkItemContent(prev, next)).toBe(prev);
  });

  it('a moved member re-renders its head, and keeps every other member object', () => {
    const prev = { rows: [head('a', ['m1', 'm2'])], pagination, planningSessions: [] };
    const next = { rows: [head('a', ['m1', 'm3'])], pagination, planningSessions: [] };
    const merged = mergeWorkItemContent(prev, next);
    expect(merged.rows[0]).not.toBe(prev.rows[0]);
    expect(merged.rows[0]!.groupMembers[0]).toBe(prev.rows[0]!.groupMembers[0]);
    expect(merged.rows[0]!.groupMembers[1]!.id).toBe('m3');
  });

  it('a head that changed while sharing its members array keeps that array', () => {
    const members = head('a', ['m1']).groupMembers;
    const prev = {
      rows: [{ ...head('a'), groupMembers: members }],
      pagination,
      planningSessions: [],
    };
    const next = {
      rows: [{ ...head('a', [], 'renamed'), groupMembers: members }],
      pagination,
      planningSessions: [],
    };
    const merged = mergeWorkItemContent(prev, next);
    expect(merged.rows[0]!.title).toBe('renamed');
    expect(merged.rows[0]!.groupMembers).toBe(members);
  });

  it('planning sessions merge by session id, and a new page is a change', () => {
    const prev = { rows: [], pagination, planningSessions: [session('s1')] };
    const same = mergeWorkItemContent(prev, {
      rows: [],
      pagination,
      planningSessions: [session('s1')],
    });
    expect(same).toBe(prev);
    const paged = mergeWorkItemContent(prev, {
      rows: [],
      pagination: { ...pagination, page: 2 },
      planningSessions: [session('s1')],
    });
    expect(paged).not.toBe(prev);
    expect(paged.planningSessions).toBe(prev.planningSessions);
  });
});

describe('workItemContentOf', () => {
  const page = (extra: object = {}) => ({ items: [], total: 0, page: 1, pageSize: 25, ...extra });
  const read = (tab: string, p: object) =>
    ({
      tab,
      window: { kind: 'workItems', page: p, members: [], workflow: { statuses: [] } },
      counts: ZERO_COUNTS,
      readAt: '2026-10-14T00:00:00.000Z',
    }) as unknown as Parameters<typeof workItemContentOf>[0];

  it('carries To resume its planning sessions, and no other tab any', () => {
    expect(
      workItemContentOf(read('to-resume', page({ planningSessions: [session('s1')] })))!
        .planningSessions,
    ).toEqual([session('s1')]);
    expect(workItemContentOf(read('to-resume', page()))!.planningSessions).toEqual([]);
    expect(
      workItemContentOf(read('todo', page({ planningSessions: [session('s1')] })))!
        .planningSessions,
    ).toEqual([]);
    expect(workItemContentOf(read('watching', page()))!.rows).toEqual([]);
  });

  it('is null for a window that is not a work-item list', () => {
    expect(
      workItemContentOf({
        tab: 'approvals',
        window: { kind: 'approvals', queue: { items: [], total: 0, truncated: false } },
        counts: ZERO_COUNTS,
        readAt: '2026-10-14T00:00:00.000Z',
      } as unknown as Parameters<typeof workItemContentOf>[0]),
    ).toBeNull();
  });
});

describe('useWorkbenchWindow', () => {
  it('a server render for the SAME view merges into what is held', () => {
    // Server props are stable objects between renders, as a page's are.
    const seed = { content: ['a'], counts: { ...ZERO_COUNTS, toDo: 1 } };
    const { result, rerender } = renderHook(
      ({ content, counts }: typeof seed) =>
        useWorkbenchWindow<string[]>({
          tab: 'todo',
          page: 1,
          content,
          counts,
          fromWindow: () => null,
          merge: keepIfEqual,
        }),
      { initialProps: seed },
    );
    const held = result.current.content;
    // An equal render: merged, and what is held does not move.
    rerender({ content: ['a'], counts: { ...ZERO_COUNTS, toDo: 1 } });
    expect(result.current.content).toBe(held);
    rerender({ content: ['a', 'b'], counts: { ...ZERO_COUNTS, toDo: 2 } });
    expect(result.current.content).toEqual(['a', 'b']);
    expect(result.current.counts.toDo).toBe(2);
  });
});

describe('useTabWindowContent', () => {
  it('outside the view it holds its seed and its reread is inert', () => {
    const { result } = renderHook(() =>
      useTabWindowContent('approvals', ['seed'], () => ['read'], keepIfEqual),
    );
    expect(result.current.content).toEqual(['seed']);
    expect(() => result.current.reread()).not.toThrow();
    expect(result.current.failures).toBe(0);
  });

  it("a window for the OTHER tab leaves this tab's content alone", () => {
    const planningWindow = {
      kind: 'planning' as const,
      page: { items: [], total: 0, page: 1, pageSize: 25 },
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WorkbenchTabWindowContext.Provider
        value={{ window: planningWindow, reread: () => {}, failures: 0 }}
      >
        {children}
      </WorkbenchTabWindowContext.Provider>
    );
    const { result } = renderHook(
      () => useTabWindowContent('approvals', ['seed'], () => ['read'], keepIfEqual),
      { wrapper },
    );
    expect(result.current.content).toEqual(['seed']);
  });
});

describe('useWorkbenchLiveStream', () => {
  it('a signal that names no tabs still nudges, with nothing moved', async () => {
    const fake = fakeLiveSource();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LiveSignalProvider source={fake.source}>{children}</LiveSignalProvider>
    );
    const { result } = renderHook(() => useWorkbenchLiveStream(true), { wrapper });
    await fake.fire({ kind: 'workbench' });
    expect(result.current.nudge).toBe(1);
    expect(result.current.moved).toEqual([]);
    await fake.fire({ kind: 'workbench' }, ['toDo']);
    expect(result.current.nudge).toBe(2);
    expect(result.current.moved).toEqual(['toDo']);
  });
});
