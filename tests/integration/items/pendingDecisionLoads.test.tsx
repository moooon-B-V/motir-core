import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// THE DECISION-WAITING MARKER ON `/items` (Story MOTIR-4908 · MOTIR-5881) — every
// place the page loads rows asks `pendingDecisionsFor` ONCE for the ids it just
// read, and hands the answer BESIDE the rows. Driven on a REAL Postgres through the
// real services; only the session, the active project and the server-side intl
// helpers are stubbed (a test has no request).
//
// The six loads: the List, the filtered (static) Tree and the lazy Tree's first
// roots — all in `IssueTreeSection` — and the three lazy-level actions (roots,
// a work item's children, a folder's level).

const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async () => (key: string) => key,
}));

import { db } from '@/lib/db';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import {
  listChildIssuesAction,
  listFolderLevelAction,
  listRootIssuesAction,
} from '@/app/(authed)/items/actions';
import { IssueTreeSection } from '@/app/(authed)/items/_components/IssueTreeSection';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';
import type { TreeTableRow } from '@/components/ui/TreeTable';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

let fx: WorkItemFixture;
let otherId: string;
let members: WorkspaceMemberDTO[];

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "approval_gate", "folder" RESTART IDENTITY CASCADE',
  );
  fx = await makeWorkItemFixture();
  const other = await createTestUser({ email: 'ana@ex.com', name: 'Ana Ruiz' });
  await workspacesService.addMember({ userId: other.id, workspaceId: fx.workspaceId });
  otherId = other.id;
  members = [
    {
      userId: fx.ownerId,
      name: 'Owner',
      email: 'owner@ex.com',
      workspaceRole: 'manager',
      customRole: null,
    },
    {
      userId: otherId,
      name: 'Ana Ruiz',
      email: 'ana@ex.com',
      workspaceRole: 'member',
      customRole: null,
    },
  ];
  session.current = { user: { id: fx.ownerId } };
  activeCtx.current = { projectId: fx.projectId, userId: fx.ownerId, workspaceId: fx.workspaceId };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function item(opts: {
  title: string;
  kind?: 'task' | 'story' | 'subtask';
  parentId?: string;
  assigneeId?: string | null;
}) {
  const created = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind ?? 'task',
      title: opts.title,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
    fx.ctx,
  );
  await adminDb.workItem.update({
    where: { id: created.id },
    data: { assigneeId: opts.assigneeId ?? null },
  });
  return created;
}

async function gate(workItemId: string) {
  await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId,
        kind: 'design_result',
        subjectId: `subject-${workItemId}`,
      },
      tx,
    ),
  );
}

/** Walk a rendered element tree for the first element whose props carry `rows`. */
function findProps<T>(node: ReactNode, key: string): T | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findProps<T>(child, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const props = (node as ReactElement<Record<string, unknown>>).props ?? {};
  if (key in props) return props[key] as T;
  return findProps<T>(props.children as ReactNode, key);
}

function flatten(rows: TreeTableRow<IssueRowData>[]): IssueRowData[] {
  return rows.flatMap((r) => [r.data, ...flatten(r.children ?? [])]);
}

async function section(view: 'list' | 'tree', filtered = false) {
  const workflow = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
  return IssueTreeSection({
    projectId: fx.projectId,
    workspaceId: fx.workspaceId,
    userId: fx.ownerId,
    view,
    sort: DEFAULT_SORT,
    filter: filtered ? { ...EMPTY_FILTER, statuses: ['todo'] } : EMPTY_FILTER,
    ast: null,
    page: 1,
    workflow,
    members,
  });
}

describe('IssueTreeSection — ONE pendingDecisionsFor call per load, the answer on the rows', () => {
  it('the LIST: a gate routed to the reader is loud, someone else’s names them, none is null', async () => {
    const mine = await item({ title: 'Mine', assigneeId: fx.ownerId });
    const theirs = await item({ title: 'Theirs', assigneeId: otherId });
    const bare = await item({ title: 'Bare', assigneeId: fx.ownerId });
    await gate(mine.id);
    await gate(theirs.id);
    const spy = vi.spyOn(approvalGatesService, 'pendingDecisionsFor');

    const rows = findProps<IssueRowData[]>(await section('list'), 'rows')!;
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(byId.get(mine.id)?.pendingDecision?.state).toBe('yours');
    expect(byId.get(theirs.id)?.pendingDecision?.state).toBe('others');
    expect(byId.get(theirs.id)?.pendingRoutedToName).toBe('Ana Ruiz');
    expect(byId.get(bare.id)?.pendingDecision).toBeNull();
  });

  it('the FILTERED tree: nested rows carry the marker, from one call over the whole forest', async () => {
    const story = await item({ title: 'Story', kind: 'story', assigneeId: fx.ownerId });
    const child = await item({
      title: 'Child',
      kind: 'subtask',
      parentId: story.id,
      assigneeId: fx.ownerId,
    });
    await gate(child.id);
    const spy = vi.spyOn(approvalGatesService, 'pendingDecisionsFor');

    const rows = findProps<TreeTableRow<IssueRowData>[]>(await section('tree', true), 'rows')!;
    const byId = new Map(flatten(rows).map((r) => [r.id, r]));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].workItemIds.sort()).toEqual([story.id, child.id].sort());
    expect(byId.get(child.id)?.pendingDecision?.state).toBe('yours');
    expect(byId.get(story.id)?.pendingDecision).toBeNull();
  });

  it('the LAZY tree’s first roots: the answer is handed to the island as `initialPending`', async () => {
    const mine = await item({ title: 'Mine', assigneeId: fx.ownerId });
    await item({ title: 'Bare', assigneeId: fx.ownerId });
    await gate(mine.id);
    const spy = vi.spyOn(approvalGatesService, 'pendingDecisionsFor');

    const pending = findProps<Record<string, { state: string }>>(
      await section('tree'),
      'initialPending',
    )!;

    expect(spy).toHaveBeenCalledTimes(1);
    expect(Object.keys(pending)).toEqual([mine.id]);
    expect(pending[mine.id]?.state).toBe('yours');
  });
});

describe('the lazy-level actions — each level brings its own answer, asked once', () => {
  it('ROOTS', async () => {
    const mine = await item({ title: 'Mine', assigneeId: fx.ownerId });
    const bare = await item({ title: 'Bare', assigneeId: fx.ownerId });
    await gate(mine.id);
    const spy = vi.spyOn(approvalGatesService, 'pendingDecisionsFor');

    const result = await listRootIssuesAction({ sortParam: 'key:asc' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.ok && result.pending[mine.id]?.state).toBe('yours');
    expect(result.ok && result.pending[bare.id]).toBeUndefined();
  });

  it('a work item’s CHILDREN — a row appended by expand carries its own level’s marker', async () => {
    const story = await item({ title: 'Story', kind: 'story', assigneeId: fx.ownerId });
    const child = await item({
      title: 'Child',
      kind: 'subtask',
      parentId: story.id,
      assigneeId: otherId,
    });
    await gate(child.id);
    const spy = vi.spyOn(approvalGatesService, 'pendingDecisionsFor');

    const result = await listChildIssuesAction({ parentId: story.id, sortParam: 'key:asc' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.ok && result.pending[child.id]).toEqual({
      state: 'others',
      kind: 'design_result',
      routedToId: otherId,
    });
  });

  it('a FOLDER’s level — its filed items carry the marker, and a child folder gets no entry', async () => {
    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Later' },
      fx.ctx,
    );
    const inner = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: folder.id, name: 'Inner' },
      fx.ctx,
    );
    const filed = await item({ title: 'Filed', assigneeId: fx.ownerId });
    await foldersService.fileWorkItem(filed.id, { folderId: folder.id }, fx.ctx);
    await gate(filed.id);
    const spy = vi.spyOn(approvalGatesService, 'pendingDecisionsFor');

    const result = await listFolderLevelAction({ folderId: folder.id, sortParam: 'key:asc' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].workItemIds).toEqual([filed.id]);
    expect(result.ok && result.pending[filed.id]?.state).toBe('yours');
    expect(result.ok && result.pending[inner.id]).toBeUndefined();
  });
});
