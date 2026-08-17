import { Prisma, type WorkItemKind } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Work-item + work-item-link RLS — direct-DB tenancy proof (Subtask 1.4.5).
//
// The Story-1.4 companion to tests/project-rls.test.ts. That file proves the
// `project` table's workspace gate; this file extends the same shape to the
// two issue-data tables Story 1.4 shipped so far — `work_item` and
// `work_item_link` — and additionally proves:
//   * the work_item RESTRICTIVE project-narrowing policy (read-side AND,
//     never a widening OR — see the add_work_item_rls migration comment),
//   * that the project narrowing does NOT touch work_item_link (cross-project
//     links inside one workspace are a v1 use case),
//   * PRODECT_FINDINGS #19: the six structural-integrity trigger functions
//     (kind/depth/cycle on work_item + cycle/self/workspace on
//     work_item_link) still enforce correctly when their internal SELECTs run
//     under FORCE RLS as the non-bypass motir_app role.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE
// ROW LEVEL SECURITY. Every RLS assertion below therefore runs inside a
// transaction that `SET LOCAL ROLE motir_app` (the NOSUPERUSER NOBYPASSRLS
// role installed by the add_workspace_rls migration). Without the role switch
// each assertion would assert the OPPOSITE of reality. The role reverts at
// txn end. The asAppRole helper is intentionally a local copy of the one in
// project-rls.test.ts / multi-tenant-rls.test.ts — the RLS suites each carry
// their own copy; see those files for why it isn't hoisted yet.
//
// asAppRole binds the SAME three GUCs that withWorkspaceContext
// (lib/workspaces/context.ts) binds — app.user_id, app.workspace_id, and the
// new app.project_id — then drops to motir_app so the policies bite. It is
// "withWorkspaceContext under the non-bypass role". A dedicated test at the
// bottom exercises withWorkspaceContext directly to prove it binds
// app.project_id.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface WorkItemTenantFixture {
  userAId: string;
  userBId: string;
  workspaceW1Id: string;
  workspaceW2Id: string;
  // W1 has two projects (P1, P1b); W2 has one (P2).
  projectP1Id: string;
  projectP1bId: string;
  projectP2Id: string;
  // Work items: two in W1/P1, one in W1/P1b, two in W2/P2.
  itemP1aId: string;
  itemP1bId_inP1: string;
  itemP1b_otherProjectId: string;
  itemP2aId: string;
  itemP2bId: string;
  // One link in each workspace.
  linkW1Id: string;
  linkW2Id: string;
}

let positionCounter = 0;
function nextPosition(): string {
  // Any strictly-increasing text is a valid fractional-index `position` for
  // these fixtures (we never reorder them). Monotonic base-36 keeps them
  // unique without pulling in the positioning helper.
  positionCounter += 1;
  return `a${positionCounter.toString(36)}`;
}

// Create a work item directly (no workItemsService yet — it lands in the
// parallel Subtask 1.4.4). Runs as the superuser during fixture setup, so RLS
// doesn't bite here; the structural triggers DO still run, so every fixture
// item must be structurally valid. `key`/`identifier` are unique per project.
async function makeWorkItem(args: {
  workspaceId: string;
  projectId: string;
  reporterId: string;
  kind: WorkItemKind;
  key: number;
  parentId?: string | null;
}): Promise<string> {
  const row = await adminDb.workItem.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      reporterId: args.reporterId,
      kind: args.kind,
      key: args.key,
      identifier: `WI-${args.key}-${args.projectId.slice(-4)}`,
      title: `Item ${args.key}`,
      position: nextPosition(),
      parentId: args.parentId ?? null,
    },
  });
  return row.id;
}

// Two independent tenants. User A owns workspace W1 (projects P1 + P1b); user
// B owns workspace W2 (project P2). Work items + one workspace link per
// tenant. Built via the real services for users/workspaces/projects so the
// workspace context + membership match production; work items are inserted
// directly (no service yet).
async function makeWorkItemTenants(): Promise<WorkItemTenantFixture> {
  const userA = await usersService.createUser({
    email: 'wi-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'WI Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'wi-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'WI Tenant B',
  });
  const w1 = await workspacesService.createWorkspace({
    name: 'WI Workspace 1',
    ownerUserId: userA.id,
  });
  const w2 = await workspacesService.createWorkspace({
    name: 'WI Workspace 2',
    ownerUserId: userB.id,
  });
  const p1 = await projectsService.createProject({
    workspaceId: w1.workspace.id,
    actorUserId: userA.id,
    name: 'Project One',
    identifier: 'PONE',
  });
  const p1b = await projectsService.createProject({
    workspaceId: w1.workspace.id,
    actorUserId: userA.id,
    name: 'Project One B',
    identifier: 'PONEB',
  });
  const p2 = await projectsService.createProject({
    workspaceId: w2.workspace.id,
    actorUserId: userB.id,
    name: 'Project Two',
    identifier: 'PTWO',
  });

  // W1 / P1: two epics. W1 / P1b: one epic. W2 / P2: two epics.
  const itemP1a = await makeWorkItem({
    workspaceId: w1.workspace.id,
    projectId: p1.id,
    reporterId: userA.id,
    kind: 'epic',
    key: 1,
  });
  const itemP1b_inP1 = await makeWorkItem({
    workspaceId: w1.workspace.id,
    projectId: p1.id,
    reporterId: userA.id,
    kind: 'epic',
    key: 2,
  });
  const itemP1b_otherProject = await makeWorkItem({
    workspaceId: w1.workspace.id,
    projectId: p1b.id,
    reporterId: userA.id,
    kind: 'epic',
    key: 1,
  });
  const itemP2a = await makeWorkItem({
    workspaceId: w2.workspace.id,
    projectId: p2.id,
    reporterId: userB.id,
    kind: 'epic',
    key: 1,
  });
  const itemP2b = await makeWorkItem({
    workspaceId: w2.workspace.id,
    projectId: p2.id,
    reporterId: userB.id,
    kind: 'epic',
    key: 2,
  });

  // W1 link: a CROSS-PROJECT relates_to (P1 item ↔ P1b item) inside one
  // workspace — exactly the v1 use case the link table must allow and the
  // project narrowing must NOT hide. W2 link: a within-project relates_to.
  const linkW1 = await adminDb.workItemLink.create({
    data: {
      workspaceId: w1.workspace.id,
      fromId: itemP1a,
      toId: itemP1b_otherProject,
      kind: 'relates_to',
      createdById: userA.id,
    },
  });
  const linkW2 = await adminDb.workItemLink.create({
    data: {
      workspaceId: w2.workspace.id,
      fromId: itemP2a,
      toId: itemP2b,
      kind: 'relates_to',
      createdById: userB.id,
    },
  });

  return {
    userAId: userA.id,
    userBId: userB.id,
    workspaceW1Id: w1.workspace.id,
    workspaceW2Id: w2.workspace.id,
    projectP1Id: p1.id,
    projectP1bId: p1b.id,
    projectP2Id: p2.id,
    itemP1aId: itemP1a,
    itemP1bId_inP1: itemP1b_inP1,
    itemP1b_otherProjectId: itemP1b_otherProject,
    itemP2aId: itemP2a,
    itemP2bId: itemP2b,
    linkW1Id: linkW1.id,
    linkW2Id: linkW2.id,
  };
}

/**
 * Run `fn` inside a transaction that (a) optionally binds the user +
 * workspace + project GUCs the RLS policies read and (b) drops to the
 * non-bypass `motir_app` role for the duration of the transaction. The role
 * switch is what makes RLS actually bite (the default superuser bypasses it);
 * the role reverts when the transaction ends.
 *
 * Mirrors withWorkspaceContext's GUC binding (lib/workspaces/context.ts) plus
 * the role drop. Local copy of the helper in tests/project-rls.test.ts — the
 * RLS suites each carry their own copy.
 */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; projectId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.projectId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.project_id', ${ctx.projectId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

/**
 * A LEGAL epic → story → task → subtask chain (the deepest the depth limit
 * allows) inside `projectId`, built as the owner. `firstKey` is the first of the
 * four per-project keys it consumes.
 *
 * Used by the MOTIR-2895 cases that need a full-depth ancestor chain sitting in a
 * project OTHER than the one the writer has bound.
 */
async function makeLegalChainIn(
  fx: WorkItemTenantFixture,
  projectId: string,
  firstKey: number,
): Promise<{ epicId: string; storyId: string; taskId: string; subtaskId: string }> {
  const base = {
    workspaceId: fx.workspaceW1Id,
    projectId,
    reporterId: fx.userAId,
  };
  const epicId = await makeWorkItem({ ...base, kind: 'epic', key: firstKey });
  const storyId = await makeWorkItem({
    ...base,
    kind: 'story',
    key: firstKey + 1,
    parentId: epicId,
  });
  const taskId = await makeWorkItem({
    ...base,
    kind: 'task',
    key: firstKey + 2,
    parentId: storyId,
  });
  const subtaskId = await makeWorkItem({
    ...base,
    kind: 'subtask',
    key: firstKey + 3,
    parentId: taskId,
  });
  return { epicId, storyId, taskId, subtaskId };
}

/**
 * INSERT a work_item as RAW SQL — no `RETURNING`, and therefore no read of the
 * inserted row.
 *
 * Two reasons the MOTIR-2895 cases need this rather than `tx.workItem.create`:
 *
 *   1. **Prisma's create always emits `RETURNING`**, and the RESTRICTIVE
 *      `work_item_project_narrow` policy is applied to the returned row — so a
 *      writer bound to project P inserting into project Q fails with *"new row
 *      violates row-level security policy \"work_item_project_narrow\""*
 *      (measured) regardless of what the triggers decide. That RLS error MASKS
 *      the trigger's verdict, which is the thing under test.
 *   2. A **direct SQL write** is the first scenario the trigger file's own header
 *      names as why these triggers exist at all. Proving them against the ORM
 *      only would leave that scenario unmeasured — the same gap, one layer up,
 *      that let MOTIR-2884 sit for a year behind owner-role tests.
 */
async function insertRawWorkItem(
  tx: Prisma.TransactionClient,
  row: {
    id: string;
    workspaceId: string;
    projectId: string;
    reporterId: string;
    kind: WorkItemKind;
    key: number;
    parentId: string;
  },
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO public."work_item"
       ("id","workspaceId","projectId","reporterId","kind","key","identifier","title","position","parentId","updatedAt")
     VALUES ($1, $2, $3, $4, $5::public.work_item_kind, $6, $7, $8, $9, $10, now())`,
    row.id,
    row.workspaceId,
    row.projectId,
    row.reporterId,
    row.kind,
    row.key,
    `WI-RAW-${row.key}`,
    `Raw ${row.kind} ${row.key}`,
    nextPosition(),
    row.parentId,
  );
}

/**
 * The Postgres error behind a rejected write, from EITHER client shape.
 *
 * A rejected `tx.workItem.create` surfaces the pg error as `err.cause`; a
 * rejected `$executeRawUnsafe` wraps it as a Prisma `P2010` whose
 * `meta.driverAdapterError.cause` carries the SQLSTATE and message. That is a
 * driver detail, not a behavioural difference, so it is unwrapped in one place
 * rather than asserted around at each call site.
 */
function pgErrorOf(err: unknown): { code?: string; message?: string } | null {
  if (!err || typeof err !== 'object') return null;
  const direct = (err as { cause?: unknown }).cause;
  if (direct && typeof direct === 'object' && 'code' in direct) {
    return direct as { code?: string; message?: string };
  }
  const adapterCause = (
    err as { meta?: { driverAdapterError?: { cause?: { code?: string; message?: string } } } }
  ).meta?.driverAdapterError?.cause;
  return adapterCause ?? null;
}

/** Assert a write was REFUSED by a trigger: SQLSTATE 23514 + the WI_* marker. */
async function expectTriggerRefusal(promise: Promise<unknown>, marker: string): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(
    err,
    `expected the write to be REFUSED with ${marker}, but it was ACCEPTED`,
  ).not.toBeNull();
  const pg = pgErrorOf(err);
  expect(pg?.code).toBe('23514');
  expect(pg?.message).toContain(marker);
}

describe('work_item RLS — read isolation', () => {
  it('with NO GUC set, the motir_app role sees zero work_item rows', async () => {
    await makeWorkItemTenants();
    const rows = await asAppRole({}, (tx) => tx.workItem.findMany());
    expect(rows).toEqual([]);
  });

  it("with the W1 GUC bound, only W1's work items are visible — never W2's", async () => {
    const fx = await makeWorkItemTenants();
    const rows = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' },
      (tx) => tx.workItem.findMany(),
    );
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([fx.itemP1aId, fx.itemP1bId_inP1, fx.itemP1b_otherProjectId].sort());
    expect(ids).not.toContain(fx.itemP2aId);
    expect(ids).not.toContain(fx.itemP2bId);
  });

  it("tenant A cannot SELECT tenant B's work item by id", async () => {
    const fx = await makeWorkItemTenants();
    const rows = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' },
      (tx) => tx.workItem.findMany({ where: { id: fx.itemP2aId } }),
    );
    expect(rows).toEqual([]);
  });
});

describe('work_item RLS — project narrowing (restrictive policy)', () => {
  it('with app.project_id = P1, only P1 work items are visible (P1b hidden)', async () => {
    const fx = await makeWorkItemTenants();
    const rows = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: fx.projectP1Id },
      (tx) => tx.workItem.findMany(),
    );
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([fx.itemP1aId, fx.itemP1bId_inP1].sort());
    // The P1b-project item shares the workspace but a different project — the
    // restrictive policy AND-narrows it out.
    expect(ids).not.toContain(fx.itemP1b_otherProjectId);
  });

  it('with app.project_id = "" (empty), ALL W1 work items across projects are visible', async () => {
    const fx = await makeWorkItemTenants();
    const rows = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' },
      (tx) => tx.workItem.findMany(),
    );
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([fx.itemP1aId, fx.itemP1bId_inP1, fx.itemP1b_otherProjectId].sort());
  });

  it('project narrowing does NOT widen across workspaces (W1 GUC + P2 id sees nothing)', async () => {
    // Sharp test of permissive-vs-restrictive: P2 belongs to W2. With the W1
    // workspace GUC bound, even setting project_id to P2 must NOT surface
    // W2's rows — the workspace PERMISSIVE policy still requires the row to
    // be in W1, and no W1 row is in project P2, so the result is empty. A
    // widening (OR) bug would leak W2's P2 rows here.
    const fx = await makeWorkItemTenants();
    const rows = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: fx.projectP2Id },
      (tx) => tx.workItem.findMany(),
    );
    expect(rows).toEqual([]);
  });
});

describe('work_item_link RLS — workspace scope, no project narrowing', () => {
  it('with NO GUC set, the motir_app role sees zero work_item_link rows', async () => {
    await makeWorkItemTenants();
    const rows = await asAppRole({}, (tx) => tx.workItemLink.findMany());
    expect(rows).toEqual([]);
  });

  it("with the W1 GUC bound, only W1's link is visible — never W2's", async () => {
    const fx = await makeWorkItemTenants();
    const rows = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' },
      (tx) => tx.workItemLink.findMany(),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([fx.linkW1Id]);
    expect(ids).not.toContain(fx.linkW2Id);
  });

  it('project narrowing does NOT apply to work_item_link (P1 GUC still shows the cross-project W1 link)', async () => {
    const fx = await makeWorkItemTenants();
    // linkW1 spans P1 ↔ P1b. With app.project_id = P1 the work_item project
    // policy would hide the P1b endpoint, but the LINK table has no project
    // policy, so the link row itself stays visible.
    const rows = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: fx.projectP1Id },
      (tx) => tx.workItemLink.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([fx.linkW1Id]);
  });
});

describe('work_item RLS — write isolation (WITH CHECK)', () => {
  it('INSERT of a work_item into a foreign workspace is denied (42501)', async () => {
    const fx = await makeWorkItemTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' }, (tx) =>
        tx.workItem.create({
          data: {
            workspaceId: fx.workspaceW2Id, // foreign — fails WITH CHECK
            projectId: fx.projectP2Id,
            reporterId: fx.userAId,
            kind: 'epic',
            key: 999,
            identifier: 'WI-SMUGGLE',
            title: 'Smuggled',
            position: 'a0',
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    // Sanity (ADMIN client): nothing landed in W2. Read by a client no policy
    // hides rows from, so absent and invisible stay distinguishable.
    const leaked = await adminDb.workItem.findFirst({
      where: { workspaceId: fx.workspaceW2Id, identifier: 'WI-SMUGGLE' },
    });
    expect(leaked).toBeNull();
  });

  it('UPDATE that flips work_item.workspaceId to a foreign workspace is denied (42501)', async () => {
    const fx = await makeWorkItemTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' }, (tx) =>
        tx.workItem.update({
          where: { id: fx.itemP1aId },
          data: { workspaceId: fx.workspaceW2Id },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    // Sanity (ADMIN client): the row still belongs to W1.
    const row = await adminDb.workItem.findUnique({ where: { id: fx.itemP1aId } });
    expect(row?.workspaceId).toBe(fx.workspaceW1Id);
  });

  it("UPDATE on a foreign workspace's work item affects zero rows (P2025)", async () => {
    const fx = await makeWorkItemTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' }, (tx) =>
        tx.workItem.update({
          where: { id: fx.itemP2aId },
          data: { title: 'Hijacked by A' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });
  });
});

describe('work_item_link RLS — write isolation (WITH CHECK)', () => {
  it('INSERT of a work_item_link into a foreign workspace is denied (42501)', async () => {
    const fx = await makeWorkItemTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' }, (tx) =>
        tx.workItemLink.create({
          data: {
            workspaceId: fx.workspaceW2Id, // foreign — fails WITH CHECK
            fromId: fx.itemP2aId,
            toId: fx.itemP2bId,
            kind: 'duplicates',
            createdById: fx.userAId,
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    // Sanity (ADMIN client): no smuggled link in W2.
    const leaked = await adminDb.workItemLink.findFirst({
      where: { workspaceId: fx.workspaceW2Id, kind: 'duplicates' },
    });
    expect(leaked).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PRODECT_FINDINGS #19 — trigger functions under FORCE RLS as motir_app
// ---------------------------------------------------------------------------
// The six structural-integrity trigger functions each run internal SELECTs
// against work_item / work_item_link. Under FORCE RLS as the non-bypass role
// those SELECTs are filtered by the active GUCs. These tests perform
// trigger-validated writes INSIDE the workspace context as motir_app and
// confirm the triggers still fire when they should (and pass when they
// should). Within a single workspace a row and its ancestors / link endpoints
// share one workspaceId, so the active app.workspace_id GUC matches every row
// the triggers walk — the integrity checks see the whole subtree.
//
// Writes here bind app.project_id = '' (the operating mode for issue/link
// creation): the workspace GUC alone gates the write, and the trigger SELECTs
// see all in-workspace rows regardless of project. (A write that bound a
// MISMATCHED project_id could narrow a work_item trigger's parent lookup —
// noted in the PR; the service always binds the target project or '', so the
// gap is not reachable in practice.)
describe('PRODECT_FINDINGS #19 — work_item triggers fire under RLS', () => {
  it('kind-parent rule still rejects an illegal parent under RLS (parent is visible to the trigger)', async () => {
    const fx = await makeWorkItemTenants();
    // Parent itemP1a is an epic in W1/P1. A `subtask` parented to an epic is
    // illegal (subtask ∈ {story, task, bug}). The kind trigger must SELECT
    // the parent's kind; if RLS hid the parent it would read NULL and WRONGLY
    // defer to the FK (silent pass). We assert it still rejects → the trigger
    // saw the parent under RLS.
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' }, (tx) =>
        tx.workItem.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            projectId: fx.projectP1Id,
            reporterId: fx.userAId,
            kind: 'subtask',
            key: 500,
            identifier: 'WI-ILLEGAL',
            title: 'Illegal subtask under epic',
            position: 'a1',
            parentId: fx.itemP1aId,
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('a structurally-valid same-workspace insert succeeds under RLS', async () => {
    const fx = await makeWorkItemTenants();
    // A `story` parented to the epic itemP1a is legal (story ∈ {epic}). The
    // kind + depth triggers must SELECT the parent and pass.
    const created = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' },
      (tx) =>
        tx.workItem.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            projectId: fx.projectP1Id,
            reporterId: fx.userAId,
            kind: 'story',
            key: 501,
            identifier: 'WI-VALID',
            title: 'Valid story under epic',
            position: 'a2',
            parentId: fx.itemP1aId,
          },
        }),
    );
    expect(created.id).toBeTruthy();
    expect(created.parentId).toBe(fx.itemP1aId);
  });
});

describe('PRODECT_FINDINGS #19 — work_item_link triggers fire under RLS', () => {
  it('cycle prevention still rejects an is_blocked_by cycle under RLS (existing link visible to the CTE)', async () => {
    const fx = await makeWorkItemTenants();
    // Seed A is_blocked_by B (ADMIN client; valid). Then under RLS as motir_app
    // attempt B is_blocked_by A — a 2-cycle. The cycle trigger's recursive CTE
    // must SELECT the seed link row; if RLS hid it the cycle would go
    // undetected and WRONGLY pass. We assert it rejects.
    await adminDb.workItemLink.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        fromId: fx.itemP1aId,
        toId: fx.itemP1bId_inP1,
        kind: 'is_blocked_by',
        createdById: fx.userAId,
      },
    });
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' }, (tx) =>
        tx.workItemLink.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            fromId: fx.itemP1bId_inP1,
            toId: fx.itemP1aId,
            kind: 'is_blocked_by',
            createdById: fx.userAId,
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('self-link rejection still fires under RLS', async () => {
    const fx = await makeWorkItemTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' }, (tx) =>
        tx.workItemLink.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            fromId: fx.itemP1aId,
            toId: fx.itemP1aId,
            kind: 'relates_to',
            createdById: fx.userAId,
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('workspace-consistency trigger still passes a valid same-workspace link under RLS', async () => {
    const fx = await makeWorkItemTenants();
    // fromId (P1) and toId (P1b) share workspace W1; the workspace trigger
    // SELECTs both items' workspaceId — both visible under the W1 GUC — and
    // passes. A fresh kind/pair avoids the unique (fromId,toId,kind) seed.
    const created = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' },
      (tx) =>
        tx.workItemLink.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            fromId: fx.itemP1aId,
            toId: fx.itemP1b_otherProjectId,
            kind: 'duplicates',
            createdById: fx.userAId,
          },
        }),
    );
    expect(created.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// MOTIR-2884 — the cross-workspace check must hold for a BOUND writer
// ---------------------------------------------------------------------------
// The block above proves the six triggers still fire when every row they walk
// lies INSIDE the bound context. That is the easy half, and 1.4.5 measured
// only that half — which is how the following survived a year.
//
// enforce_work_item_link_workspace() is the one function whose SUBJECT is a
// row in another tenant: it exists to compare fromItem.workspaceId with
// toItem.workspaceId, so a genuine violation puts one endpoint OUTSIDE the
// writer's workspace BY CONSTRUCTION. As a plain SECURITY INVOKER function its
// two lookups ran under the invoking statement's policies, the foreign
// endpoint read NULL, and the function took its "defer to the FK" branch — but
// the FK is satisfied, because the row exists (referential-integrity checks are
// themselves exempt from RLS). The write the trigger exists to REFUSE went
// through, silently, with no error and no log.
//
// So these cases attempt the VIOLATION as a bound motir_app writer rather than
// as the owner. They are RED against the pre-MOTIR-2884 function and green once
// 20260817120000_link_workspace_trigger_security_definer marks it SECURITY
// DEFINER; the migration carries the per-function verdict for the other five.
describe('MOTIR-2884 — link workspace trigger refuses a cross-tenant write as motir_app', () => {
  it('REFUSES a link whose toId lives in another workspace (WI_LINK_CROSS_WORKSPACE)', async () => {
    const fx = await makeWorkItemTenants();
    // Bound to W1. fromId is W1's item, toId is W2's — invisible to this
    // writer, which is exactly the case the trigger is FOR. The link row's own
    // workspaceId is W1, so the RLS WITH CHECK passes and the trigger is the
    // only thing standing between this statement and a cross-tenant row.
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' }, (tx) =>
        tx.workItemLink.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            fromId: fx.itemP1aId,
            toId: fx.itemP2aId,
            kind: 'relates_to',
            createdById: fx.userAId,
          },
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23514', message: expect.stringContaining('WI_LINK_CROSS_WORKSPACE') },
    });

    // And nothing was written — the assertion above would also pass if the
    // insert failed for some unrelated reason, so read the table back.
    const rows = await adminDb.workItemLink.findMany({ where: { toId: fx.itemP2aId } });
    expect(rows).toHaveLength(0);
  });

  it('REFUSES a link whose denormalized workspaceId disagrees with fromItem (WI_LINK_WORKSPACE_MISMATCH)', async () => {
    const fx = await makeWorkItemTenants();
    // Bound to W2, writing a link row stamped W2 whose two endpoints both live
    // in W1. Under the invoker function BOTH lookups came back NULL and the
    // mismatch branch was never reached; the row landed in W2 pointing at W1's
    // items, which is precisely the tenancy corruption the denormalized column
    // exists to make impossible.
    await expect(
      asAppRole({ userId: fx.userBId, workspaceId: fx.workspaceW2Id, projectId: '' }, (tx) =>
        tx.workItemLink.create({
          data: {
            workspaceId: fx.workspaceW2Id,
            fromId: fx.itemP1aId,
            toId: fx.itemP1bId_inP1,
            kind: 'relates_to',
            createdById: fx.userBId,
          },
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23514', message: expect.stringContaining('WI_LINK_WORKSPACE_MISMATCH') },
    });

    // Scoped to W2 — the fixture already owns a legitimate W1 link out of
    // itemP1a, so an unscoped read here would match that and prove nothing.
    const rows = await adminDb.workItemLink.findMany({
      where: { fromId: fx.itemP1aId, workspaceId: fx.workspaceW2Id },
    });
    expect(rows).toHaveLength(0);
  });

  it('REFUSES the cross-workspace link even when app.project_id narrows the lookup', async () => {
    const fx = await makeWorkItemTenants();
    // The second axis of the same defect, and the one the 1.4.5 comment waved
    // through as "not reachable in practice": work_item carries a RESTRICTIVE
    // FOR SELECT policy that narrows to app.project_id, so a bound project
    // hides an in-WORKSPACE endpoint too. With P1 bound, W2's item is hidden
    // twice over. The refusal must not depend on which GUCs happen to be set.
    await expect(
      asAppRole(
        { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: fx.projectP1Id },
        (tx) =>
          tx.workItemLink.create({
            data: {
              workspaceId: fx.workspaceW1Id,
              fromId: fx.itemP1aId,
              toId: fx.itemP2aId,
              kind: 'relates_to',
              createdById: fx.userAId,
            },
          }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23514', message: expect.stringContaining('WI_LINK_CROSS_WORKSPACE') },
    });
  });

  it('still ACCEPTS a legal cross-PROJECT link with app.project_id bound (the widened reach does not over-reject)', async () => {
    const fx = await makeWorkItemTenants();
    // The guard on the fix itself. A cross-project link inside one workspace is
    // a v1 use case, and with P1 bound the P1b endpoint is hidden from the
    // INVOKER — so before this fix the trigger passed this write by SKIPPING
    // its check, and after it the trigger passes by actually performing it.
    // Both endpoints resolve to W1 and the row's workspaceId matches.
    const created = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: fx.projectP1Id },
      (tx) =>
        tx.workItemLink.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            fromId: fx.itemP1aId,
            toId: fx.itemP1b_otherProjectId,
            kind: 'clones',
            createdById: fx.userAId,
          },
        }),
    );
    expect(created.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// MOTIR-2895 — the database checks parent TENANCY, and the parent-chain walks
// are complete because of it
// ---------------------------------------------------------------------------
// The block above fixed the ONE trigger whose subject is a row in another
// tenant. Writing its per-function verdict surfaced the other half: the three
// work_item parent-chain functions each RESOLVE the parent and each DEFER when
// that lookup reads NULL, and their "the parent is always in-context" premise
// held only because `workItemsService` refuses a cross-project parent
// (`CrossProjectParentError`). NOTHING in the database compared
// parent."workspaceId" / parent."projectId" with the child's — so the DB
// backstop's completeness rested on the application check it exists to backstop.
//
// `enforce_work_item_parent_tenancy()` (20260817160000) closes that, and these
// cases are its proof under the ROLE — the lesson of 2884 being that a trigger
// exercised only as the owner is a trigger whose RLS behaviour is unmeasured.
// The last three cases are the evidence for the amended SECURITY DEFINER verdict
// on kind / depth / cycle; each is ACCEPTED (silently, with the row landing)
// against those functions as SECURITY INVOKER.
describe('MOTIR-2895 — parent tenancy is refused for a bound motir_app writer', () => {
  it('REFUSES an INSERT whose parentId lives in another WORKSPACE (WI_PARENT_CROSS_WORKSPACE)', async () => {
    const fx = await makeWorkItemTenants();
    // Bound to W1, writing a W1/P1 row whose parent is W2's epic — a parent that
    // is invisible to this writer, which is precisely the case the check is FOR.
    // A story under an epic is kind-LEGAL, so nothing but the tenancy check can
    // reject this.
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' }, (tx) =>
        tx.workItem.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            projectId: fx.projectP1Id,
            reporterId: fx.userAId,
            kind: 'story',
            key: 600,
            identifier: 'WI-XWS',
            title: 'Story under another tenant’s epic',
            position: nextPosition(),
            parentId: fx.itemP2aId,
          },
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23514', message: expect.stringContaining('WI_PARENT_CROSS_WORKSPACE') },
    });

    // The assertion above would also pass if the insert failed for an unrelated
    // reason, so read the table back as the owner.
    const rows = await adminDb.workItem.findMany({ where: { parentId: fx.itemP2aId } });
    expect(rows).toHaveLength(0);
  });

  it('REFUSES an INSERT whose parentId lives in another PROJECT of the same workspace (WI_PARENT_CROSS_PROJECT)', async () => {
    const fx = await makeWorkItemTenants();
    // Same workspace, so RLS's own WITH CHECK is satisfied and the workspace arm
    // of the new check passes — the project arm is the only thing left. Bound to
    // the CHILD's project, which is the shape a project-scoped writer has.
    await expect(
      asAppRole(
        { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: fx.projectP1Id },
        (tx) =>
          tx.workItem.create({
            data: {
              workspaceId: fx.workspaceW1Id,
              projectId: fx.projectP1Id,
              reporterId: fx.userAId,
              kind: 'story',
              key: 601,
              identifier: 'WI-XPROJ',
              title: 'Story under a sibling project’s epic',
              position: nextPosition(),
              parentId: fx.itemP1b_otherProjectId,
            },
          }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23514', message: expect.stringContaining('WI_PARENT_CROSS_PROJECT') },
    });

    const rows = await adminDb.workItem.findMany({
      where: { parentId: fx.itemP1b_otherProjectId },
    });
    expect(rows).toHaveLength(0);
  });

  it('REFUSES the cross-project parent with app.project_id UNBOUND too (the refusal does not depend on which GUCs are set)', async () => {
    const fx = await makeWorkItemTenants();
    // With app.project_id = '' the parent is perfectly VISIBLE to the writer, so
    // this case would pass even under SECURITY INVOKER — it is here because a
    // tenancy check whose answer moves with the caller's narrowing is not a
    // check. Same violation, opposite GUC, same marker.
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' }, (tx) =>
        tx.workItem.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            projectId: fx.projectP1Id,
            reporterId: fx.userAId,
            kind: 'story',
            key: 602,
            identifier: 'WI-XPROJ-UNBOUND',
            title: 'Story under a sibling project’s epic, unnarrowed',
            position: nextPosition(),
            parentId: fx.itemP1b_otherProjectId,
          },
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23514', message: expect.stringContaining('WI_PARENT_CROSS_PROJECT') },
    });
  });

  it('REFUSES a cross-project RE-PARENT (UPDATE), not only an INSERT', async () => {
    const fx = await makeWorkItemTenants();
    const story = await makeWorkItem({
      workspaceId: fx.workspaceW1Id,
      projectId: fx.projectP1Id,
      reporterId: fx.userAId,
      kind: 'story',
      key: 603,
      parentId: fx.itemP1aId,
    });

    await expect(
      asAppRole(
        { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: fx.projectP1Id },
        (tx) =>
          tx.workItem.update({
            where: { id: story },
            data: { parentId: fx.itemP1b_otherProjectId },
          }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23514', message: expect.stringContaining('WI_PARENT_CROSS_PROJECT') },
    });

    const after = await adminDb.workItem.findUnique({ where: { id: story } });
    expect(after?.parentId).toBe(fx.itemP1aId);
  });

  it('still ACCEPTS a legal same-project parent with app.project_id bound (the check does not over-reject)', async () => {
    const fx = await makeWorkItemTenants();
    // The guard on the fix itself: the ordinary write every user makes, with the
    // narrowing that would hide a foreign parent, must still go through.
    const created = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: fx.projectP1Id },
      (tx) =>
        tx.workItem.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            projectId: fx.projectP1Id,
            reporterId: fx.userAId,
            kind: 'story',
            key: 604,
            identifier: 'WI-SAME-PROJ',
            title: 'Story under its own project’s epic',
            position: nextPosition(),
            parentId: fx.itemP1aId,
          },
        }),
    );
    expect(created.parentId).toBe(fx.itemP1aId);
  });

  it('the DEPTH and CYCLE walks are complete for a LEGAL chain under the role', async () => {
    const fx = await makeWorkItemTenants();
    // epic → story → task, all in W1/P1, built as the owner.
    const story = await makeWorkItem({
      workspaceId: fx.workspaceW1Id,
      projectId: fx.projectP1Id,
      reporterId: fx.userAId,
      kind: 'story',
      key: 610,
      parentId: fx.itemP1aId,
    });
    const task = await makeWorkItem({
      workspaceId: fx.workspaceW1Id,
      projectId: fx.projectP1Id,
      reporterId: fx.userAId,
      kind: 'task',
      key: 611,
      parentId: story,
    });
    const bound = {
      userId: fx.userAId,
      workspaceId: fx.workspaceW1Id,
      projectId: fx.projectP1Id,
    };

    // The 4th level is legal — the walk must count 3 ancestors, not fewer.
    const subtask = await asAppRole(bound, (tx) =>
      tx.workItem.create({
        data: {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          reporterId: fx.userAId,
          kind: 'subtask',
          key: 612,
          identifier: 'WI-L4',
          title: 'L4 subtask',
          position: nextPosition(),
          parentId: task,
        },
      }),
    );
    expect(subtask.parentId).toBe(task);

    // The 5th is not. A truncated walk would UNDER-count and admit it.
    await expect(
      asAppRole(bound, (tx) =>
        tx.workItem.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            projectId: fx.projectP1Id,
            reporterId: fx.userAId,
            kind: 'subtask',
            key: 613,
            identifier: 'WI-L5',
            title: 'L5 too deep',
            position: nextPosition(),
            parentId: subtask.id,
          },
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23514', message: expect.stringContaining('WI_DEPTH_LIMIT_EXCEEDED') },
    });

    // And the cycle walk: moving the story under its own grandchild. cycle sorts
    // before kind, so the cycle error is the one that surfaces (this re-parent is
    // also kind-illegal).
    await expect(
      asAppRole(bound, (tx) =>
        tx.workItem.update({ where: { id: story }, data: { parentId: subtask.id } }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23514', message: expect.stringContaining('WI_PARENT_CYCLE') },
    });
  });

  it('the DEPTH walk is complete even when app.project_id names a DIFFERENT project than the row (the SECURITY DEFINER case)', async () => {
    const fx = await makeWorkItemTenants();
    // A legal 4-deep chain in P1b, and a writer bound to P1. RLS permits the
    // write: `work_item_project_narrow` is FOR SELECT only, so nothing pins the
    // written row's project to the bound one — only its WORKSPACE is pinned. So
    // the row lands in P1b while every ancestor of it is hidden from an INVOKER
    // lookup, and the depth walk returns a SMALLER max(lvl): it passes by
    // under-counting, with no error to notice.
    //
    // Raw SQL, deliberately: the ORM's create emits RETURNING, and the same
    // restrictive policy rejects the RETURNED row ("new row violates row-level
    // security policy \"work_item_project_narrow\"" — measured), which MASKS the
    // trigger's verdict behind an RLS error. A direct SQL write is also the exact
    // scenario the file header names as this trigger's reason to exist.
    const chain = await makeLegalChainIn(fx, fx.projectP1bId, 700);

    await expectTriggerRefusal(
      asAppRole(
        { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: fx.projectP1Id },
        (tx) =>
          insertRawWorkItem(tx, {
            id: 'wi-2895-depth',
            workspaceId: fx.workspaceW1Id,
            projectId: fx.projectP1bId,
            reporterId: fx.userAId,
            kind: 'subtask',
            key: 704,
            parentId: chain.subtaskId,
          }),
      ),
      'WI_DEPTH_LIMIT_EXCEEDED',
    );

    expect(await adminDb.workItem.count({ where: { id: 'wi-2895-depth' } })).toBe(0);
  });

  it('the KIND matrix applies in that same shape (the other SECURITY DEFINER case)', async () => {
    const fx = await makeWorkItemTenants();
    // Same shape, the kind axis: a `story` parented to a STORY is illegal (story
    // ∈ {epic}), and shallow enough that depth does not trip first. Under
    // SECURITY INVOKER the parent read NULL, the function deferred to the FK, the
    // FK was satisfied because the row exists, and the illegal row landed.
    const chain = await makeLegalChainIn(fx, fx.projectP1bId, 710);

    await expectTriggerRefusal(
      asAppRole(
        { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: fx.projectP1Id },
        (tx) =>
          insertRawWorkItem(tx, {
            id: 'wi-2895-kind',
            workspaceId: fx.workspaceW1Id,
            projectId: fx.projectP1bId,
            reporterId: fx.userAId,
            kind: 'story',
            key: 714,
            parentId: chain.storyId,
          }),
      ),
      'WI_ILLEGAL_PARENT_TYPE',
    );

    expect(await adminDb.workItem.count({ where: { id: 'wi-2895-kind' } })).toBe(0);
  });
});

describe('withWorkspaceContext binds app.project_id', () => {
  // Directly exercises the lib/workspaces/context.ts change: the helper must
  // bind app.project_id as a third GUC (empty string when projectId is
  // absent). Runs as the superuser — we're asserting the GUC value the helper
  // SET, not RLS visibility.
  it('binds the provided projectId', async () => {
    const value = await withWorkspaceContext(
      { userId: 'u1', workspaceId: 'w1', projectId: 'proj-123' },
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: string }>>`
          SELECT current_setting('app.project_id', true) AS pid`;
        return rows[0]?.pid;
      },
    );
    expect(value).toBe('proj-123');
  });

  it('binds an empty string when projectId is absent', async () => {
    const value = await withWorkspaceContext({ userId: 'u1', workspaceId: 'w1' }, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pid: string }>>`
          SELECT current_setting('app.project_id', true) AS pid`;
      return rows[0]?.pid;
    });
    expect(value).toBe('');
  });
});
