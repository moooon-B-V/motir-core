// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// BacklogContainer (Subtask 4.2.3, read render): a pure client consumer of the
// Story-4.1 reads + the 4.2.3 sprint-list binding. It fetches `/api/sprints`
// (planning headers), `/api/sprints/[id]/issues` (per sprint), and `/api/backlog`
// (the bounded ranked list), and renders the two stacked regions + their states.
// Stub next/navigation + the create-issue context + global fetch so the client
// orchestration is testable under happy-dom, DB-free (the board-container idiom).
// Under happy-dom there is no measurable viewport, so `useRowWindow` degrades to
// render-all — the bounded-COUNT contract (header = aggregate total, not loaded
// rows) is still asserted here; the virtualized-DOM-bounded proof is the 4.2.6 E2E.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/backlog',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: vi.fn(),
    openCreateIssue: vi.fn(),
    canCreate: true,
    issuesChangedAt: 0,
  }),
}));

import { BacklogContainer } from '@/app/(authed)/backlog/_components/BacklogContainer';

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

const workflow = {
  statuses: [
    { id: 's1', key: 'todo', label: 'To do', category: 'todo', position: 'a0', color: null },
    {
      id: 's2',
      key: 'in_progress',
      label: 'In progress',
      category: 'in_progress',
      position: 'a1',
      color: null,
    },
    { id: 's3', key: 'done', label: 'Done', category: 'done', position: 'a2', color: null },
  ],
  transitions: [],
  policyMode: 'open',
} as unknown as WorkflowDto;

const members = [
  { userId: 'u1', name: 'Yue Zhu', email: 'yue@example.com' },
  { userId: 'u2', name: 'Ana Ruiz', email: 'ana@example.com' },
] as unknown as WorkspaceMemberDTO[];

function sprint(over: Partial<SprintDto> & { id: string; name: string }): SprintDto {
  return {
    goal: null,
    state: 'planned',
    startDate: null,
    endDate: null,
    completedAt: null,
    sequence: 1,
    issueCount: 0,
    committedPoints: null,
    committedIssueCount: null,
    ...over,
  };
}

function item(over: Partial<WorkItemSummaryDto> & { id: string; key: number }): WorkItemSummaryDto {
  return {
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Item ${over.key}`,
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    archivedAt: null,
    ...over,
  };
}

interface MockData {
  sprints: SprintDto[];
  backlog: { items: WorkItemSummaryDto[]; nextCursor: string | null; totalCount: number };
  sprintIssues: { items: WorkItemSummaryDto[]; nextCursor: string | null; totalCount: number };
  sprintsOk?: boolean;
}

function mockFetch(data: MockData) {
  const ok = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/issues')) return ok(data.sprintIssues);
    if (url.startsWith('/api/sprints')) {
      if (data.sprintsOk === false) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        } as Response);
      }
      return ok({ sprints: data.sprints });
    }
    if (url.startsWith('/api/backlog')) return ok(data.backlog);
    return ok({});
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe('BacklogContainer (4.2.3 read render)', () => {
  it('renders active + planned sprint containers (excludes completed) and the backlog region', async () => {
    mockFetch({
      sprints: [
        sprint({ id: 'active1', name: 'Sprint 24', state: 'active', sequence: 1, issueCount: 5 }),
        sprint({ id: 'planned1', name: 'Sprint 25', state: 'planned', sequence: 2, issueCount: 4 }),
        sprint({ id: 'done1', name: 'Sprint 23', state: 'complete', sequence: 0, issueCount: 9 }),
      ],
      backlog: { items: [item({ id: 'b1', key: 150 })], nextCursor: null, totalCount: 1 },
      sprintIssues: { items: [], nextCursor: null, totalCount: 0 },
    });

    render(<BacklogContainer workflow={workflow} members={members} />);

    expect(await screen.findByText('Sprint 24')).toBeTruthy();
    expect(screen.getByText('Sprint 25')).toBeTruthy();
    // Completed sprints are NOT shown on the planning view (mirror: Jira).
    expect(screen.queryByText('Sprint 23')).toBeNull();
    // The sprint state pills + the backlog region.
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Planned')).toBeTruthy();
    expect(screen.getByTestId('sprint-count-active1').textContent).toBe('5');
    expect(screen.getByTestId('backlog-count')).toBeTruthy();
  });

  it('shows the BOUNDED count header from the aggregate total, not the loaded-row tally', async () => {
    mockFetch({
      sprints: [],
      backlog: {
        items: [item({ id: 'b1', key: 150 }), item({ id: 'b2', key: 151 })],
        nextCursor: 'cursor-1',
        totalCount: 1284,
      },
      sprintIssues: { items: [], nextCursor: null, totalCount: 0 },
    });

    render(<BacklogContainer workflow={workflow} members={members} />);

    // Header reflects the 1,284 aggregate even though only 2 rows are loaded.
    await waitFor(() => expect(screen.getByTestId('backlog-count').textContent).toContain('284'));
    expect(screen.getByTestId('backlog-row-PROD-150')).toBeTruthy();
    expect(screen.getByTestId('backlog-row-PROD-151')).toBeTruthy();
    // hasMore (nextCursor set) → no "all loaded" end-cap yet.
    expect(screen.queryByText(/loaded/i)).toBeNull();
  });

  it('resolves a row status pill + assignee from the workflow + member maps', async () => {
    mockFetch({
      sprints: [],
      backlog: {
        items: [item({ id: 'b1', key: 150, status: 'in_progress', assigneeId: 'u1' })],
        nextCursor: null,
        totalCount: 1,
      },
      sprintIssues: { items: [], nextCursor: null, totalCount: 0 },
    });

    render(<BacklogContainer workflow={workflow} members={members} />);

    expect(await screen.findByTestId('backlog-row-PROD-150')).toBeTruthy();
    // status key → workflow label; assignee id → member initial avatar (title).
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByTitle('Yue Zhu')).toBeTruthy();
  });

  it('renders the empty-backlog EmptyState when the read returns zero rows', async () => {
    mockFetch({
      sprints: [],
      backlog: { items: [], nextCursor: null, totalCount: 0 },
      sprintIssues: { items: [], nextCursor: null, totalCount: 0 },
    });

    render(<BacklogContainer workflow={workflow} members={members} />);

    expect(await screen.findByText('Backlog is clear')).toBeTruthy();
  });

  it('renders the page error state when the sprint list fails', async () => {
    mockFetch({
      sprints: [],
      sprintsOk: false,
      backlog: { items: [], nextCursor: null, totalCount: 0 },
      sprintIssues: { items: [], nextCursor: null, totalCount: 0 },
    });

    render(<BacklogContainer workflow={workflow} members={members} />);

    expect(await screen.findByText("Couldn't load sprints")).toBeTruthy();
  });

  it('shows a loading skeleton before the sprint list resolves', () => {
    mockFetch({
      sprints: [],
      backlog: { items: [], nextCursor: null, totalCount: 0 },
      sprintIssues: { items: [], nextCursor: null, totalCount: 0 },
    });

    render(<BacklogContainer workflow={workflow} members={members} />);
    // Synchronous first paint: the fetch hasn't resolved yet.
    expect(screen.getByTestId('backlog-skeleton')).toBeTruthy();
  });
});
