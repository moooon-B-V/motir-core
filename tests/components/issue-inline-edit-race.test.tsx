// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { IssueRowData } from '@/app/(authed)/issues/_components/issueRows';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { IssueActionResult } from '@/app/(authed)/issues/[key]/edit/actions';

// Repro for bug-inline-status-revert-on-second-edit: inline-edit item A's
// status on /issues, then item B's — intermittently A's cell flips back to its
// OLD status although the DB row holds the NEW one (display-only; Yue verified
// the backend). Root cause: every inline edit refreshed the WHOLE tree
// (revalidatePath in the action + router.refresh() in the cell), so two rapid
// edits raced multiple full-page snapshots and a stale one applying last
// re-rendered A from old server props. The fix removes the refresh fan-out —
// a successful action response IS the confirmation, nothing repaints — so
// this suite locks in BOTH halves of the contract:
//   1. a successful inline edit fires NO router.refresh() at all;
//   2. if stale server props DO arrive anyway (a sibling cell's stale-conflict
//      refresh, a navigation payload — simulated here by rerendering with a
//      pre-write DB snapshot AFTER the fresh one), the confirmed cell still
//      does not revert (useConvergingOverride yields only once the row's
//      updatedAt catches up with the acknowledged write).
//
// Per the card (and the reproduce-before-diagnosing rule) this drives the REAL
// workItemsService against the real test Postgres for every write and for both
// refresh-payload snapshots, so the test also locks in the backend-correct
// fact: the DB row holds the new status throughout while only the rendered
// cell diverges. Only the Server Action boundary is stubbed (no cookies in the
// test env — same line the sibling issue-inline-edit suite draws), but the stub
// delegates to the real service; the test controls WHEN each call's write runs
// and WHEN its result reaches the component, which is exactly the freedom the
// production race exploits.
const { statusCalls, updateCalls, refreshSpy, pushSpy, toastSpy } = vi.hoisted(() => ({
  statusCalls: [] as Array<{
    input: { id: string; toStatusKey: string };
    resolve: (r: unknown) => void;
  }>,
  updateCalls: [] as Array<{
    input: { id: string; expectedUpdatedAt?: string; assigneeId?: string | null };
    resolve: (r: unknown) => void;
  }>,
  refreshSpy: vi.fn(),
  pushSpy: vi.fn(),
  toastSpy: vi.fn(),
}));
vi.mock('@/app/(authed)/issues/[key]/edit/actions', () => ({
  changeStatusAction: (input: { id: string; toStatusKey: string }) =>
    new Promise((resolve) => statusCalls.push({ input, resolve })),
  updateIssueAction: (input: { id: string; expectedUpdatedAt?: string }) =>
    new Promise((resolve) => updateCalls.push({ input, resolve })),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy, refresh: refreshSpy }),
  usePathname: () => '/issues',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';
import { IssueListTable } from '@/app/(authed)/issues/_components/IssueListTable';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

beforeAll(() => {
  // Radix needs a few browser APIs happy-dom lacks (same shims as the sibling
  // inline-edit suite).
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['scrollIntoView'] = vi.fn();
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  statusCalls.length = 0;
  updateCalls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Shape a real WorkItemDto into the row payload the list cells render. */
function toRow(
  dto: WorkItemDto,
  workflow: WorkflowDto,
  members: WorkspaceMemberDTO[],
): IssueRowData {
  const meta = workflow.statuses.find((s) => s.key === dto.status);
  const member = dto.assigneeId ? members.find((m) => m.userId === dto.assigneeId) : undefined;
  return {
    id: dto.id,
    identifier: dto.identifier,
    title: dto.title,
    kind: dto.kind,
    status: dto.status,
    statusLabel: meta?.label ?? dto.status,
    statusCategory: meta?.category ?? null,
    assigneeId: dto.assigneeId,
    assigneeName: member ? member.name || member.email : null,
    updatedAt: dto.updatedAt,
    priority: dto.priority,
    reporterName: 'Owner',
    dueDate: dto.dueDate,
    dueLabel: null,
    estimateMinutes: dto.estimateMinutes,
    estimateLabel: null,
    storyPoints: dto.storyPoints,
    storyPointsLabel: null,
    hasChildren: false,
  };
}

interface Harness {
  fx: WorkItemFixture;
  a: WorkItemDto;
  b: WorkItemDto;
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
  snapshot: () => Promise<IssueRowData[]>;
  table: (rows: IssueRowData[]) => React.ReactElement;
}

async function makeHarness(): Promise<Harness> {
  const fx = await makeWorkItemFixture();
  const a = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Item A' },
    fx.ctx,
  );
  const b = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Item B' },
    fx.ctx,
  );
  const workflow = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
  const members: WorkspaceMemberDTO[] = [
    { userId: fx.ownerId, name: fx.owner.name, email: fx.owner.email, role: 'owner' },
  ];
  const snapshot = async () => {
    const [a2, b2] = await Promise.all([
      workItemsService.getWorkItem(a.id, fx.ctx),
      workItemsService.getWorkItem(b.id, fx.ctx),
    ]);
    return [toRow(a2, workflow, members), toRow(b2, workflow, members)];
  };
  const table = (rows: IssueRowData[]) => (
    <IssueListTable
      rows={rows}
      sort={{ column: 'key', direction: 'asc' }}
      filter={EMPTY_FILTER}
      pagination={{ total: rows.length, page: 1, pageSize: 50 }}
      workflow={workflow}
      members={members}
    />
  );
  return { fx, a, b, workflow, members, snapshot, table };
}

function rowOf(title: string): HTMLElement {
  const row = screen
    .getAllByRole('row')
    .find((r) => within(r).queryByText(title, { exact: false }));
  expect(row, `row containing "${title}"`).toBeTruthy();
  return row!;
}

/** Resolve a captured Server-Action call into the component, inside act. */
async function deliver(call: { resolve: (r: unknown) => void }, result: IssueActionResult) {
  await act(async () => {
    call.resolve(result);
  });
}

describe('bug-inline-status-revert-on-second-edit — two rapid inline edits, adversarial ordering', () => {
  it('STATUS: the first cell keeps its new status when a stale refresh payload lands after the fresh one (DB holds the new status throughout)', async () => {
    const h = await makeHarness();
    const initial = await h.snapshot();
    expect(initial.map((r) => r.status)).toEqual(['todo', 'todo']);
    const { rerender } = render(h.table(initial));

    // Edit A: To Do → In Progress. The action call is captured (in flight).
    fireEvent.click(within(rowOf('Item A')).getByRole('button', { name: 'Edit Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]!.input).toEqual({ id: h.a.id, toStatusKey: 'in_progress' });
    // Optimistic override shows the pick immediately.
    expect(within(rowOf('Item A')).getByRole('button', { name: 'Edit Status' }).textContent).toBe(
      'In Progress',
    );

    // Promptly edit B the same way — A's write is still in flight.
    fireEvent.click(within(rowOf('Item B')).getByRole('button', { name: 'Edit Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));
    expect(statusCalls).toHaveLength(2);
    expect(statusCalls[1]!.input).toEqual({ id: h.b.id, toStatusKey: 'in_progress' });

    // B's (faster) write commits first and its action resolves. A pre-A-write
    // DB snapshot taken NOW (A still 'todo') is the stale payload some OTHER
    // surface could still hand the table later.
    const bDto = await workItemsService.updateStatus(h.b.id, 'in_progress', h.fx.ctx);
    await deliver(statusCalls[1]!, { ok: true, updatedAt: bDto.updatedAt });
    const stalePayload = await h.snapshot();
    expect(stalePayload.find((r) => r.id === h.a.id)!.status).toBe('todo'); // not yet written
    expect(stalePayload.find((r) => r.id === h.b.id)!.status).toBe('in_progress');

    // A's write commits and its action resolves. From here on the DB row holds
    // A's NEW status — the backend-correct fact the card scopes to.
    const aDto = await workItemsService.updateStatus(h.a.id, 'in_progress', h.fx.ctx);
    expect((await workItemsService.getWorkItem(h.a.id, h.fx.ctx)).status).toBe('in_progress');
    await deliver(statusCalls[0]!, { ok: true, updatedAt: aDto.updatedAt });
    const freshPayload = await h.snapshot();
    expect(freshPayload.map((r) => r.status)).toEqual(['in_progress', 'in_progress']);
    // Contract half 1: success = confirmed, full stop — NO whole-tree refresh.
    expect(refreshSpy).not.toHaveBeenCalled();

    // Contract half 2: even if payloads DO arrive, in adversarial order — the
    // FRESH snapshot applies first…
    rerender(h.table(freshPayload));
    expect(within(rowOf('Item A')).getByRole('button', { name: 'Edit Status' }).textContent).toBe(
      'In Progress',
    );
    // …then the STALE snapshot lands last. The cell must NOT revert: the DB
    // (asserted above and again below) has held 'in_progress' all along.
    rerender(h.table(stalePayload));
    expect(within(rowOf('Item A')).getByRole('button', { name: 'Edit Status' }).textContent).toBe(
      'In Progress',
    );
    // B was never stale in either payload and stays put.
    expect(within(rowOf('Item B')).getByRole('button', { name: 'Edit Status' }).textContent).toBe(
      'In Progress',
    );
    expect((await workItemsService.getWorkItem(h.a.id, h.fx.ctx)).status).toBe('in_progress');
    expect((await workItemsService.getWorkItem(h.b.id, h.fx.ctx)).status).toBe('in_progress');
  });

  it('ASSIGNEE: the first cell keeps its new assignee under the same interleaving (DB holds the new assignee throughout)', async () => {
    const h = await makeHarness();
    const owner = h.members[0]!;
    const ownerLabel = owner.name || owner.email;
    // The fixture's generated email contains regex specials (`+`) — escape it.
    const ownerOption = new RegExp(owner.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const initial = await h.snapshot();
    const { rerender } = render(h.table(initial));

    // Assign A to the owner (combobox option name = label + secondary email —
    // match on the email substring), then promptly assign B too.
    fireEvent.click(within(rowOf('Item A')).getByRole('button', { name: 'Edit Assignee' }));
    fireEvent.click(screen.getByRole('option', { name: ownerOption }));
    fireEvent.click(within(rowOf('Item B')).getByRole('button', { name: 'Edit Assignee' }));
    fireEvent.click(screen.getByRole('option', { name: ownerOption }));
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]!.input).toMatchObject({ id: h.a.id, assigneeId: owner.userId });
    expect(updateCalls[1]!.input).toMatchObject({ id: h.b.id, assigneeId: owner.userId });

    // B's write commits + resolves first; a pre-A-write snapshot has A unassigned.
    const bDto = await workItemsService.updateWorkItem(
      h.b.id,
      { assigneeId: owner.userId },
      h.fx.ctx,
      { expectedUpdatedAt: updateCalls[1]!.input.expectedUpdatedAt },
    );
    await deliver(updateCalls[1]!, { ok: true, updatedAt: bDto.updatedAt });
    const stalePayload = await h.snapshot();
    expect(stalePayload.find((r) => r.id === h.a.id)!.assigneeId).toBeNull();

    // A's write commits + resolves.
    const aDto = await workItemsService.updateWorkItem(
      h.a.id,
      { assigneeId: owner.userId },
      h.fx.ctx,
      { expectedUpdatedAt: updateCalls[0]!.input.expectedUpdatedAt },
    );
    await deliver(updateCalls[0]!, { ok: true, updatedAt: aDto.updatedAt });
    const freshPayload = await h.snapshot();
    expect(freshPayload.map((r) => r.assigneeId)).toEqual([owner.userId, owner.userId]);
    // Success = confirmed, full stop — NO whole-tree refresh.
    expect(refreshSpy).not.toHaveBeenCalled();

    // Fresh payload first, stale payload last — A must keep its new assignee.
    rerender(h.table(freshPayload));
    rerender(h.table(stalePayload));
    expect(
      within(rowOf('Item A')).getByRole('button', { name: 'Edit Assignee' }).textContent,
    ).toContain(ownerLabel);
    expect((await workItemsService.getWorkItem(h.a.id, h.fx.ctx)).assigneeId).toBe(owner.userId);
    expect((await workItemsService.getWorkItem(h.b.id, h.fx.ctx)).assigneeId).toBe(owner.userId);
  });
});
