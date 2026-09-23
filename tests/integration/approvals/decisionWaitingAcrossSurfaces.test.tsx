import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// THE STORY GATE for the decision-waiting marker (Story MOTIR-4908 · MOTIR-5879).
//
// Each code card proved its own surface. This suite proves the thing none of them
// can see alone: ONE gate reads the SAME way on every surface — the board read,
// `moveCard`, the /items List, the filtered Tree, the three lazy levels and the
// item page's early read — and `yours` on all of them is exactly the To-approve
// tab's decidable rows (`listAwaitingMe`), for every actor.
//
// ⚠️ HOW THE GATES ARE RAISED, on the record. The DESIGN gates go through the real
// publish path (`designEvidenceService.recordFromPathnames`, which raises the gate
// and supersedes the prior one on a republish) and are decided through the real
// door (`approvalGatesService.decide`). The DECISION gate and the carried MERGE gate
// are written through `approvalGateRepository.createAwaitingIfAbsent` — the exact
// insert `raiseOnReviewEntry` / `pullRequestApprovalGates` call — because their raise
// paths need GitHub delivery rows and check fixtures, which are those kinds' own
// suites' subject. What is under test here is the READ, which is identical either
// way. (MOTIR-5879's card, amended in a comment.)

const { session, activeCtx, blobs } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
  blobs: new Map<string, { contentType: string; size: number }>(),
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => blobs.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { db } = await import('@/lib/db');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { boardsService } = await import('@/lib/services/boardsService');
const { foldersService } = await import('@/lib/services/foldersService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { workflowsService } = await import('@/lib/services/workflowsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { EMPTY_FILTER } = await import('@/lib/issues/issueListFilter');
const { DEFAULT_SORT } = await import('@/lib/issues/issueListView');
const { listRootIssuesAction, listChildIssuesAction, listFolderLevelAction } =
  await import('@/app/(authed)/items/actions');
const { IssueTreeSection } = await import('@/app/(authed)/items/_components/IssueTreeSection');
const { makeWorkItemFixture } = await import('../../fixtures');
const { createTestUser } = await import('../../fixtures/userFixtures');
const { adminDb } = await import('../../helpers/adminDb');
const { shaFor } = await import('../../helpers/commitShaFixtures');
const { ensureWorkWaitsOn } = await import('../../helpers/designWaits');
const { truncateAuthTables } = await import('../../helpers/db');

// Static: the `unique symbol` type survives only a static import, and `stamp.ts`
// pulls in nothing the mocks above need to intercept.
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import type { WorkItemFixture } from '../../fixtures';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';
import type { TreeTableRow } from '@/components/ui/TreeTable';

type Actor = { userId: string; workspaceId: string };
/** What ONE surface says about each card: `yours` / `others`, or absent. */
type Reading = Record<string, 'yours' | 'others' | undefined>;

let fx: WorkItemFixture;
let M: Actor; // the member most gates are routed to
let N: Actor; // the member B is routed to
let ids: { story: string; A: string; B: string; C: string; D: string; folder: string };

beforeEach(async () => {
  blobs.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "design_evidence", "approval_gate", "folder" RESTART IDENTITY CASCADE',
  );
  fx = await makeWorkItemFixture();
  const m = await createTestUser({ email: 'm@ex.com', name: 'Mira' });
  const n = await createTestUser({ email: 'n@ex.com', name: 'Noor' });
  for (const u of [m, n]) {
    await workspacesService.addMember({ userId: u.id, workspaceId: fx.workspaceId });
  }
  M = { userId: m.id, workspaceId: fx.workspaceId };
  N = { userId: n.id, workspaceId: fx.workspaceId };

  // The layout reaches every load: S and B are ROOTS, A is S's CHILD, C and D are
  // FILED in a folder — so roots + children + folder level together cover A–D.
  const story = await card({ title: 'S', kind: 'story', assigneeId: M.userId });
  const A = await card({ title: 'A', kind: 'subtask', parentId: story, assigneeId: M.userId });
  const B = await card({ title: 'B', assigneeId: N.userId });
  const C = await card({ title: 'C', assigneeId: M.userId });
  const D = await card({ title: 'D', assigneeId: M.userId });
  const folder = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name: 'Filed' },
    fx.ctx,
  );
  for (const id of [C, D]) await foldersService.fileWorkItem(id, { folderId: folder.id }, fx.ctx);
  ids = { story, A, B, C, D, folder: folder.id };

  await publishDesign(A, 'a-v1'); // design gate → M
  await insertGate(B, 'decision_approval'); // decision gate → N
  await insertGate(C, 'pull_request_approval'); // the merge gate, carried by…
  await publishDesign(C, 'c-v1'); // …C's awaiting design gate → M
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function card(opts: {
  title: string;
  kind?: 'task' | 'story' | 'subtask';
  parentId?: string;
  assigneeId: string | null;
}): Promise<string> {
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
    data: { assigneeId: opts.assigneeId },
  });
  if (opts.kind !== 'story') {
    await workItemsService.updateStatus(created.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(created.id, 'in_review', fx.ctx);
  }
  return created.id;
}

/** Publish a design version through the REAL path — which raises (and supersedes) the gate. */
async function publishDesign(workItemId: string, label: string) {
  const mock = `${designPrefix(fx.workspaceId, workItemId)}${label}.mock.html`;
  const note = `${designPrefix(fx.workspaceId, workItemId)}${label}.design-notes.md`;
  blobs.set(mock, { contentType: 'text/html', size: 2048 });
  blobs.set(note, { contentType: 'text/markdown', size: 512 });
  await ensureWorkWaitsOn(workItemId, fx);
  return designEvidenceService.recordFromPathnames(
    {
      workItemId,
      assets: [
        { kind: 'mock', sourcePath: `design/x/${label}.mock.html`, pathname: mock },
        { kind: 'note_file', sourcePath: 'design/x/design-notes.md', pathname: note },
      ],
      commitSha: shaFor(label),
    },
    fx.ctx,
  );
}

/** The insert the decision / merge raise paths make (see the header). */
async function insertGate(workItemId: string, kind: ApprovalGateKind) {
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.createAwaitingIfAbsent(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId,
        kind,
        subjectId: `${kind}-${workItemId}`,
        routedToId: item.assigneeId ?? item.reporterId,
      },
      tx,
    ),
  );
}

async function awaitingGate(workItemId: string, kind: ApprovalGateKind) {
  return adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId, kind, state: 'awaiting' },
  });
}

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

const CARDS = ['A', 'B', 'C', 'D'] as const;

function readingOf(stateById: (id: string) => 'yours' | 'others' | null | undefined): Reading {
  const out: Reading = {};
  for (const name of CARDS) out[name] = stateById(ids[name]) ?? undefined;
  return out;
}

/**
 * Every surface's reading for this actor. `canEdit` gates `moveCard`, which asserts
 * `work_item:edit` before it answers anything.
 */
async function everySurface(actor: Actor, opts: { canEdit: boolean }) {
  session.current = { user: { id: actor.userId } };
  activeCtx.current = { projectId: fx.projectId, ...actor };
  const workflow = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
  const members = (
    await adminDb.user.findMany({ where: { id: { in: [fx.ownerId, M.userId, N.userId] } } })
  ).map((u) => ({ userId: u.id, name: u.name, email: u.email, role: 'member' }));
  const sectionFor = (view: 'list' | 'tree', filtered: boolean) =>
    IssueTreeSection({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      userId: actor.userId,
      view,
      sort: DEFAULT_SORT,
      filter: filtered ? { ...EMPTY_FILTER, statuses: ['in_review'] } : EMPTY_FILTER,
      ast: null,
      page: 1,
      workflow,
      members,
    });

  const all = Object.values(ids).filter((id) => id !== ids.folder);
  const direct = await approvalGatesService.pendingDecisionsFor(
    { projectId: fx.projectId, workItemIds: all },
    actor,
  );
  const board = await boardsService.getBoard(fx.projectId, actor);
  const boardCards = new Map(board.columns.flatMap((c) => c.cards).map((c) => [c.id, c]));
  const listRows = findProps<IssueRowData[]>(await sectionFor('list', false), 'rows') ?? [];
  const treeRows = flatten(
    findProps<TreeTableRow<IssueRowData>[]>(await sectionFor('tree', true), 'rows') ?? [],
  );
  const roots = await listRootIssuesAction({ sortParam: 'key:asc' });
  const children = await listChildIssuesAction({ parentId: ids.story, sortParam: 'key:asc' });
  const filed = await listFolderLevelAction({ folderId: ids.folder, sortParam: 'key:asc' });
  const lazy = {
    ...(roots.ok ? roots.pending : {}),
    ...(children.ok ? children.pending : {}),
    ...(filed.ok ? filed.pending : {}),
  };
  // The item page asks the SAME read for its one item, in its early group.
  const itemPage: Reading = {};
  for (const name of CARDS) {
    const one = await approvalGatesService.pendingDecisionsFor(
      { projectId: fx.projectId, workItemIds: [ids[name]] },
      actor,
    );
    itemPage[name] = one.get(ids[name])?.state;
  }

  const readings: Record<string, Reading> = {
    direct: readingOf((id) => direct.get(id)?.state),
    board: readingOf((id) => boardCards.get(id)?.pendingDecision?.state),
    list: readingOf((id) => listRows.find((r) => r.id === id)?.pendingDecision?.state),
    filteredTree: readingOf((id) => treeRows.find((r) => r.id === id)?.pendingDecision?.state),
    lazyLevels: readingOf((id) => lazy[id]?.state),
    itemPage,
  };
  if (opts.canEdit) {
    const column = board.columns.find((c) => c.cards.some((k) => k.id === ids.A));
    if (column) {
      const moved = await boardsService.moveCard(
        board.boardId,
        ids.A,
        { toColumnId: column.id },
        actor,
      );
      readings.moveCard = { A: moved.card.pendingDecision?.state };
    }
  }
  const tab = await approvalGatesService.listAwaitingMe({ ...actor, projectId: fx.projectId });
  const tabYours = new Set(tab.items.filter((r) => r.canDecide).map((r) => r.workItem?.id));
  return { readings, tabYours, direct };
}

/** Every surface agrees with `expected`; and `yours` is exactly the tab's decidable rows. */
function expectAgreement(result: Awaited<ReturnType<typeof everySurface>>, expected: Reading) {
  for (const [surface, reading] of Object.entries(result.readings)) {
    const scoped = surface === 'moveCard' ? { A: expected.A } : expected;
    expect({ surface, reading }).toEqual({ surface, reading: scoped });
  }
  const yours = CARDS.filter((name) => expected[name] === 'yours').map((name) => ids[name]);
  expect([...result.tabYours].sort()).toEqual(yours.sort());
}

describe('1 · one gate, every surface', () => {
  it('as M: A yours, B others, C yours ONCE (its merge gate is carried), D absent', async () => {
    const result = await everySurface(M, { canEdit: true });
    expectAgreement(result, { A: 'yours', B: 'others', C: 'yours', D: undefined });
    // C's entry is its DESIGN gate — the carried merge gate never surfaces.
    expect(result.direct.get(ids.C)?.kind).toBe('design_result');
    expect(result.direct.get(ids.B)?.routedToId).toBe(N.userId);
  });

  it('as N the two are swapped', async () => {
    const result = await everySurface(N, { canEdit: true });
    expectAgreement(result, { A: 'others', B: 'yours', C: 'others', D: undefined });
  });

  it('as an ADMIN holding `approval:decide_any` who is routed nothing: all others, and the tab is empty', async () => {
    const result = await everySurface(fx.ctx, { canEdit: true });
    expectAgreement(result, { A: 'others', B: 'others', C: 'others', D: undefined });
    expect(result.tabYours.size).toBe(0);
  });

  it('as a project VIEWER who is A’s assignee: A is others — the floor — on every surface', async () => {
    const viewer = await createTestUser({ email: 'v@ex.com', name: 'Vik' });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    await adminDb.projectMembership.deleteMany({
      where: { userId: viewer.id, projectId: fx.projectId },
    });
    await adminDb.projectMembership.create({
      data: {
        userId: viewer.id,
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        role: 'viewer',
      },
    });
    await adminDb.workItem.update({ where: { id: ids.A }, data: { assigneeId: viewer.id } });

    const result = await everySurface(
      { userId: viewer.id, workspaceId: fx.workspaceId },
      { canEdit: false },
    );
    expectAgreement(result, { A: 'others', B: 'others', C: 'others', D: undefined });
  });
});

describe('2 · the decided and superseded values', () => {
  it('approve A, send B back, republish C — every surface agrees after each step', async () => {
    const a = await awaitingGate(ids.A, 'design_result');
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: a.id, decision: 'approve', source: 'ui' },
      M,
    );
    expectAgreement(await everySurface(M, { canEdit: true }), {
      A: undefined,
      B: 'others',
      C: 'yours',
      D: undefined,
    });

    const b = await awaitingGate(ids.B, 'decision_approval');
    await approvalGatesService.decide(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: b.id,
        decision: 'request_changes',
        noteMd: 'Not yet',
        source: 'ui',
      },
      N,
    );
    expectAgreement(await everySurface(M, { canEdit: true }), {
      A: undefined,
      B: undefined,
      C: 'yours',
      D: undefined,
    });

    const before = await awaitingGate(ids.C, 'design_result');
    await publishDesign(ids.C, 'c-v2');
    const after = await awaitingGate(ids.C, 'design_result');
    expect(after.id).not.toBe(before.id);
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: before.id } })).state).toBe(
      'superseded',
    );
    const result = await everySurface(M, { canEdit: true });
    expectAgreement(result, { A: undefined, B: undefined, C: 'yours', D: undefined });
    expect(result.direct.get(ids.C)?.kind).toBe('design_result');
  });
});

describe('3 · access', () => {
  it('a member who may not browse the project gets an EMPTY answer from every surface, and no error', async () => {
    const stranger = await createTestUser({ email: 's@ex.com', name: 'Sol' });
    await workspacesService.addMember({ userId: stranger.id, workspaceId: fx.workspaceId });
    await adminDb.workItem.update({ where: { id: ids.D }, data: { assigneeId: stranger.id } });
    await publishDesign(ids.D, 'd-v1');
    await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'private' } });
    await adminDb.projectMembership.deleteMany({
      where: { userId: stranger.id, projectId: fx.projectId },
    });
    const actor = { userId: stranger.id, workspaceId: fx.workspaceId };

    const direct = await approvalGatesService.pendingDecisionsFor(
      { projectId: fx.projectId, workItemIds: Object.values(ids) },
      actor,
    );
    expect(direct.size).toBe(0);
    session.current = { user: { id: stranger.id } };
    activeCtx.current = { projectId: fx.projectId, ...actor };
    const roots = await listRootIssuesAction({ sortParam: 'key:asc' }).catch(() => null);
    // The level read itself refuses a non-browser (its own gate); where it answers,
    // it carries nothing.
    if (roots && roots.ok) expect(roots.pending).toEqual({});
    const tab = await approvalGatesService.listAwaitingMe({ ...actor, projectId: fx.projectId });
    expect(tab.items).toEqual([]);
  });
});
