import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE WORKBENCH PAGE'S READ SHAPE (Story MOTIR-5213 · MOTIR-5219) — the
// performance property MOTIR-5221 stated and nothing else asserts.
//
// The cascade could have been built by reading the counts FIRST on every request
// — the page cannot pick a tab until it knows them — which would serialise the
// list and the counts on every page load to serve a decision only the bare
// request needs. The redirect exists to avoid exactly that, so two properties are
// asserted here, and a green diff can break either silently:
//
//   1. A request NAMING a tab keeps the shipped read: its list, the counts, the
//      members and the workflow all START before ANY of them resolves — one
//      concurrent group, not a chain.
//   2. The BARE request reads the counts and NOTHING ELSE before it forwards: no
//      list, no members, no workflow.
//
// ⚠️ WHY THIS FILE MOCKS WHAT `tests/integration/workbench/landing-cascade.test.ts`
// DOES NOT. Concurrency is a property of WHEN reads start relative to when they
// settle, and a real database answers too fast to make that observable. So every
// read here is a gated mock that records its start and waits for the test to let
// it go — the same instrument `tests/components/item-detail-reads.test.tsx` uses.
// WHERE the page lands is proven against real Postgres in the integration suite;
// this file proves HOW it reads.

const started: string[] = [];
let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();

const deferred = <T,>(name: string, value: T) =>
  vi.fn(async () => {
    started.push(name);
    await gate;
    return value;
  });

const COUNTS = {
  myWork: 3,
  toDo: 2,
  inProgress: 1,
  recentlyFinished: 0,
  watching: 0,
  approvals: 0,
};
const WINDOW = { items: [], total: 0, page: 1, pageSize: 25 };

const reads = vi.hoisted(() => ({}) as Record<string, (...args: unknown[]) => Promise<unknown>>);

vi.mock('@/lib/auth', () => ({ getSession: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/projects', () => ({
  getActiveProject: async () => ({
    userId: 'u1',
    workspaceId: 'w1',
    projectId: 'p1',
    project: { name: 'Motir' },
  }),
}));
vi.mock('@/lib/services/homeService', () => ({
  HOME_FINISHED_WINDOW_DAYS: 7,
  HOME_PAGE_SIZE: 25,
  homeService: new Proxy({}, { get: (_t, key: string) => reads[key] }),
}));
vi.mock('@/lib/services/workspacesService', () => ({
  workspacesService: { listMembers: (...a: unknown[]) => reads['listMembers']!(...a) },
}));
vi.mock('@/lib/services/workflowsService', () => ({
  workflowsService: { getWorkflow: (...a: unknown[]) => reads['getWorkflow']!(...a) },
}));
vi.mock('@/lib/services/approvalGatesService', () => ({ approvalGatesService: {} }));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace?: string) =>
      createTranslator({ locale: 'en', messages, namespace: namespace as 'workbench' }),
  };
});
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams(),
}));

import WorkbenchPage from '@/app/(authed)/workbench/page';

beforeEach(() => {
  started.length = 0;
  gate = new Promise<void>((resolve) => (release = resolve));
  Object.assign(reads, {
    tabCounts: deferred('tabCounts', COUNTS),
    listToDo: deferred('listToDo', WINDOW),
    listInProgress: deferred('listInProgress', WINDOW),
    listRecentlyFinished: deferred('listRecentlyFinished', WINDOW),
    listWatching: deferred('listWatching', WINDOW),
    listMembers: deferred('listMembers', []),
    getWorkflow: deferred('getWorkflow', { statuses: [] }),
  });
});

afterEach(() => {
  release();
  vi.clearAllMocks();
});

/** Let every microtask the page can reach without a read resolving run out. */
const settleStarts = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a request NAMING a tab keeps the shipped parallel read', () => {
  it.each([
    ['todo', 'listToDo'],
    ['in-progress', 'listInProgress'],
    ['finished', 'listRecentlyFinished'],
    ['watching', 'listWatching'],
  ])(
    '?tab=%s starts its list, the counts, the members and the workflow TOGETHER',
    async (tab, list) => {
      const page = WorkbenchPage({ searchParams: Promise.resolve({ tab }) });
      await settleStarts();
      // Every read is IN FLIGHT while none has resolved — the gate is still shut.
      // A chain would show only its first link here.
      expect([...started].sort()).toEqual([list, 'getWorkflow', 'listMembers', 'tabCounts'].sort());
      release();
      await expect(page).resolves.toBeTruthy();
    },
  );

  it('?tab=approvals reads the counts, members and workflow together, and its rows inside the tab', async () => {
    const page = WorkbenchPage({ searchParams: Promise.resolve({ tab: 'approvals' }) });
    await settleStarts();
    expect([...started].sort()).toEqual(['getWorkflow', 'listMembers', 'tabCounts']);
    release();
    await expect(page).resolves.toBeTruthy();
  });
});

describe('the BARE request reads the counts and nothing else before it forwards', () => {
  it('starts ONLY `tabCounts`, then forwards on it', async () => {
    const page = WorkbenchPage({ searchParams: Promise.resolve({}) });
    await settleStarts();
    expect(started).toEqual(['tabCounts']);
    release();
    // COUNTS has nothing awaiting and one item moving → In progress.
    await expect(page).rejects.toThrow('NEXT_REDIRECT:/workbench?tab=in-progress');
    // …and still nothing else was read on the way out.
    expect(started).toEqual(['tabCounts']);
  });

  it('an unknown `?tab=` is the bare request too — same single read, same forward', async () => {
    const page = WorkbenchPage({ searchParams: Promise.resolve({ tab: 'nonsense' }) });
    await settleStarts();
    expect(started).toEqual(['tabCounts']);
    release();
    await expect(page).rejects.toThrow('NEXT_REDIRECT:/workbench?tab=in-progress');
  });
});
