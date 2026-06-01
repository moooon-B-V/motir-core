import { Prisma, type WorkItemKind } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
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
//     under FORCE RLS as the non-bypass prodect_app role.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE
// ROW LEVEL SECURITY. Every RLS assertion below therefore runs inside a
// transaction that `SET LOCAL ROLE prodect_app` (the NOSUPERUSER NOBYPASSRLS
// role installed by the add_workspace_rls migration). Without the role switch
// each assertion would assert the OPPOSITE of reality. The role reverts at
// txn end. The asAppRole helper is intentionally a local copy of the one in
// project-rls.test.ts / multi-tenant-rls.test.ts — the RLS suites each carry
// their own copy; see those files for why it isn't hoisted yet.
//
// asAppRole binds the SAME three GUCs that withWorkspaceContext
// (lib/workspaces/context.ts) binds — app.user_id, app.workspace_id, and the
// new app.project_id — then drops to prodect_app so the policies bite. It is
// "withWorkspaceContext under the non-bypass role". A dedicated test at the
// bottom exercises withWorkspaceContext directly to prove it binds
// app.project_id.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
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
  const row = await db.workItem.create({
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
  const linkW1 = await db.workItemLink.create({
    data: {
      workspaceId: w1.workspace.id,
      fromId: itemP1a,
      toId: itemP1b_otherProject,
      kind: 'relates_to',
      createdById: userA.id,
    },
  });
  const linkW2 = await db.workItemLink.create({
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
 * non-bypass `prodect_app` role for the duration of the transaction. The role
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
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('work_item RLS — read isolation', () => {
  it('with NO GUC set, the prodect_app role sees zero work_item rows', async () => {
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
  it('with NO GUC set, the prodect_app role sees zero work_item_link rows', async () => {
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
            position: 'z0',
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    // Sanity (superuser): nothing landed in W2.
    const leaked = await db.workItem.findFirst({
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

    // Sanity (superuser): the row still belongs to W1.
    const row = await db.workItem.findUnique({ where: { id: fx.itemP1aId } });
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

    // Sanity (superuser): no smuggled link in W2.
    const leaked = await db.workItemLink.findFirst({
      where: { workspaceId: fx.workspaceW2Id, kind: 'duplicates' },
    });
    expect(leaked).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PRODECT_FINDINGS #19 — trigger functions under FORCE RLS as prodect_app
// ---------------------------------------------------------------------------
// The six structural-integrity trigger functions each run internal SELECTs
// against work_item / work_item_link. Under FORCE RLS as the non-bypass role
// those SELECTs are filtered by the active GUCs. These tests perform
// trigger-validated writes INSIDE the workspace context as prodect_app and
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
            position: 'z1',
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
            position: 'z2',
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
    // Seed A is_blocked_by B (superuser; valid). Then under RLS as prodect_app
    // attempt B is_blocked_by A — a 2-cycle. The cycle trigger's recursive CTE
    // must SELECT the seed link row; if RLS hid it the cycle would go
    // undetected and WRONGLY pass. We assert it rejects.
    await db.workItemLink.create({
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
