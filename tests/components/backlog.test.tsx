// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { SprintDto } from '@/lib/dto/sprints';
import type { SprintPointsDto } from '@/lib/dto/estimation';
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
    estimateMinutes: null,
    storyPoints: null,
    archivedAt: null,
    ...over,
  };
}

interface MockData {
  sprints: SprintDto[];
  backlog: { items: WorkItemSummaryDto[]; nextCursor: string | null; totalCount: number };
  sprintIssues: { items: WorkItemSummaryDto[]; nextCursor: string | null; totalCount: number };
  /** The committed-points roll-up each container reads (Subtask 4.4.9 — finding
   *  #69); defaults to the unestimated `{ 0, 0, 0 }`. */
  sprintPoints?: SprintPointsDto;
  sprintsOk?: boolean;
}

function mockFetch(data: MockData) {
  const ok = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/points'))
      return ok(data.sprintPoints ?? { committed: 0, completed: 0, remaining: 0 });
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

    render(<BacklogContainer workflow={workflow} members={members} projectName="motir" />);

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

  it('fills the committed-points seam with committed · done · left from the live roll-up (Subtask 4.3.5; 4.4.9 seam)', async () => {
    mockFetch({
      sprints: [sprint({ id: 'active1', name: 'Sprint 24', state: 'active', issueCount: 5 })],
      backlog: { items: [], nextCursor: null, totalCount: 0 },
      sprintIssues: { items: [], nextCursor: null, totalCount: 0 },
      sprintPoints: { committed: 21, completed: 8, remaining: 13 },
    });

    render(<BacklogContainer workflow={workflow} members={members} projectName="motir" />);

    // The committed-points slot shows the live committed · done · left figure
    // (Subtask 4.3.5 upgraded the 4.4.9 committed-only fill to the full design),
    // no longer the reserved placeholder.
    expect(
      await screen.findByLabelText('Points: 21 committed, 8 completed, 13 remaining'),
    ).toBeTruthy();
  });

  it('renders a muted em-dash in the committed-points seam for a wholly unestimated sprint (4.3.5)', async () => {
    mockFetch({
      sprints: [sprint({ id: 'active1', name: 'Sprint 24', state: 'active', issueCount: 5 })],
      backlog: { items: [], nextCursor: null, totalCount: 0 },
      sprintIssues: { items: [], nextCursor: null, totalCount: 0 },
      sprintPoints: { committed: 0, completed: 0, remaining: 0 },
    });

    render(<BacklogContainer workflow={workflow} members={members} projectName="motir" />);

    expect(await screen.findByText('Sprint 24')).toBeTruthy();
    expect(await screen.findByLabelText('Sprint has no estimated points')).toBeTruthy();
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

    render(<BacklogContainer workflow={workflow} members={members} projectName="motir" />);

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

    render(<BacklogContainer workflow={workflow} members={members} projectName="motir" />);

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

    render(<BacklogContainer workflow={workflow} members={members} projectName="motir" />);

    expect(await screen.findByText('Backlog is clear')).toBeTruthy();
  });

  it('renders the page error state when the sprint list fails', async () => {
    mockFetch({
      sprints: [],
      sprintsOk: false,
      backlog: { items: [], nextCursor: null, totalCount: 0 },
      sprintIssues: { items: [], nextCursor: null, totalCount: 0 },
    });

    render(<BacklogContainer workflow={workflow} members={members} projectName="motir" />);

    expect(await screen.findByText("Couldn't load sprints")).toBeTruthy();
  });

  it('shows a loading skeleton before the sprint list resolves', () => {
    mockFetch({
      sprints: [],
      backlog: { items: [], nextCursor: null, totalCount: 0 },
      sprintIssues: { items: [], nextCursor: null, totalCount: 0 },
    });

    render(<BacklogContainer workflow={workflow} members={members} projectName="motir" />);
    // Synchronous first paint: the fetch hasn't resolved yet.
    expect(screen.getByTestId('backlog-skeleton')).toBeTruthy();
  });

  it('renders backlog rows as draggable sortable items (Subtask 4.2.4)', async () => {
    mockFetch({
      sprints: [],
      backlog: { items: [item({ id: 'b1', key: 150 })], nextCursor: null, totalCount: 1 },
      sprintIssues: { items: [], nextCursor: null, totalCount: 0 },
    });

    render(<BacklogContainer workflow={workflow} members={members} projectName="motir" />);

    const row = await screen.findByTestId('backlog-row-PROD-150');
    // `useSortable` marks the row a draggable item (aria-roledescription) inside
    // the backlog's single DndContext, and the whole row is the grab handle — the
    // 4.2.4 drag wiring — while the design's row semantics (role="row") survive.
    expect(row.getAttribute('aria-roledescription')).toBe('sortable');
    expect(row.getAttribute('role')).toBe('row');
    expect(row.className).toContain('cursor-grab');
  });
});

// ── Bug 11: completing a sprint refreshes EVERY region's issue list ───────────
// The complete dialog's `onCompleted` previously only re-read `/api/sprints`
// metadata (which sprints exist + their counts). The destination of the carry-
// over move — the backlog OR a target planned-sprint card — keeps its OWN
// `/api/sprints/[id]/issues` / `/api/backlog` read, which was never invalidated,
// so the moved items stayed invisible until a manual reload. The fix threads a
// shared refresh signal into every region, so completion re-reads them all. This
// proves the container-side wiring (the dialog-fires-onCompleted contract is
// already covered by complete-sprint-dialog.test.tsx) by driving the real flow
// and asserting the FAN-OUT: after completion, BOTH the backlog AND a non-target
// planned-sprint card re-fetch (the same mechanism that makes a carry INTO a
// planned sprint show its moved rows), and the carried row appears with no reload.
describe('BacklogContainer — sprint completion refreshes destination regions (bug 11)', () => {
  // The complete dialog mounts a Modal (focus trap) + a Combobox; both touch
  // browser APIs happy-dom omits (mirrors complete-sprint-dialog.test.tsx).
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
  });

  function okJson(body: unknown) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as Response);
  }

  it('re-reads the backlog and every sprint card after a sprint completes (carry → backlog)', async () => {
    const calls: string[] = [];
    let completed = false;
    // active1 has unfinished work; planned1 is an untouched future-sprint card —
    // it must STILL re-read on completion (the fan-out that makes a carry INTO a
    // planned sprint work). The carried item (PROD-300) lands in the backlog,
    // which is empty until the move commits.
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/points')) return okJson({ committed: 0, completed: 0, remaining: 0 });
      if (url.includes('/report'))
        return okJson({
          sprintId: 'active1',
          state: 'active',
          points: { committed: 5, completed: 0, notCompleted: 5 },
          completed: { items: [], nextCursor: null, totalCount: 0 },
          incomplete: {
            items: [item({ id: 'm1', key: 300, status: 'in_progress' })],
            nextCursor: null,
            totalCount: 1,
          },
          addedAfterStart: 0,
        });
      if (url.includes('/burndown'))
        return okJson({
          sprintId: 'active1',
          state: 'complete',
          statistic: 'story_points',
          committed: 5,
          startDate: '2026-06-09T00:00:00.000Z',
          endDate: '2026-06-22T00:00:00.000Z',
          days: [],
          scopeChanges: [],
        });
      if (url.includes('/complete') && init?.method === 'POST') {
        completed = true;
        return okJson(sprint({ id: 'active1', name: 'Sprint 24', state: 'complete' }));
      }
      if (url.includes('/issues')) return okJson({ items: [], nextCursor: null, totalCount: 0 });
      if (url.startsWith('/api/sprints'))
        return okJson({
          sprints: [
            sprint({
              id: 'active1',
              name: 'Sprint 24',
              state: completed ? 'complete' : 'active',
              sequence: 1,
              issueCount: 5,
            }),
            sprint({ id: 'planned1', name: 'Sprint 25', state: 'planned', sequence: 2 }),
          ],
        });
      if (url.startsWith('/api/backlog'))
        return okJson(
          completed
            ? { items: [item({ id: 'm1', key: 300 })], nextCursor: null, totalCount: 1 }
            : { items: [], nextCursor: null, totalCount: 0 },
        );
      return okJson({});
    }) as unknown as typeof fetch;

    render(<BacklogContainer workflow={workflow} members={members} projectName="motir" />);

    // Open the complete flow from the active sprint, confirm (backlog is the
    // default carry-over), then close the success report.
    fireEvent.click(await screen.findByTestId('complete-sprint-active1'));
    const dialog = await screen.findByRole('dialog', { name: 'Complete sprint' });
    const confirm = (await within(dialog).findByRole('button', {
      name: 'Complete sprint',
    })) as HTMLButtonElement;
    // The confirm enables once the report preview load resolves (no jest-dom in
    // this suite — assert the DOM `disabled` property directly).
    await waitFor(() => expect(confirm.disabled).toBe(false));

    const backlogCallsBeforeComplete = calls.filter((u) => u.startsWith('/api/backlog')).length;
    const planned1CallsBeforeComplete = calls.filter((u) =>
      u.startsWith('/api/sprints/planned1/issues'),
    ).length;

    fireEvent.click(confirm);
    // The success-state report appears once the POST resolves.
    const report = await screen.findByRole('dialog', { name: /Sprint 24 report/ });
    fireEvent.click(within(report).getByRole('button', { name: 'Done' }));

    // The fan-out: completion re-reads the backlog (the carry destination) AND
    // the untouched planned-sprint card (proving a carry INTO a planned sprint
    // would refresh its card the same way).
    await waitFor(() =>
      expect(calls.filter((u) => u.startsWith('/api/backlog')).length).toBeGreaterThan(
        backlogCallsBeforeComplete,
      ),
    );
    await waitFor(() =>
      expect(
        calls.filter((u) => u.startsWith('/api/sprints/planned1/issues')).length,
      ).toBeGreaterThan(planned1CallsBeforeComplete),
    );
    // And the carried row is now in the backlog with no remount / reload.
    expect(await screen.findByTestId('backlog-row-PROD-300')).toBeTruthy();
  });
});
