import { Prisma, type StatusCategory } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from '../helpers/db';

// Row-level security + key constraints for the status-workflow tables
// (Story 2.2 · Subtask 2.2.1) — direct-DB tenancy + integrity proof for
// `workflow_status` + `workflow_transition`. The Story-2.2 companion to
// tests/work-item-rls.test.ts and tests/jobs/rls.test.ts.
//
// Unlike the job-ledger tables, these carry NO system-admin escape hatch:
// they are pure tenant data (non-null workspace_id, always written under an
// active workspace context), so their policy is the same pure workspace gate
// `project` / `work_item` use. This file proves:
//   * with NO context, the non-bypass role sees zero rows (safe failure mode);
//   * a W1 tenant context sees ONLY W1's statuses / transitions — never W2's;
//   * a cross-workspace SELECT of a foreign row returns 0 rows;
//   * WITH CHECK rejects inserting a row whose workspace_id is foreign to the
//     active context;
//   * the partial unique index enforces exactly-one-initial-status-per-project
//     (and is correctly scoped per-project, not global);
//   * @@unique([projectId, key]) enforces stable per-project status keys
//     (and is likewise per-project).
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE
// ROW LEVEL SECURITY. Every RLS assertion below runs inside a transaction
// that `SET LOCAL ROLE prodect_app` (the NOSUPERUSER NOBYPASSRLS role). The
// asAppRole helper binds the same GUC withWorkspaceContext binds
// (app.workspace_id) then drops the role so the policies bite; it reverts at
// txn end. Local copy of the helper, per the convention each RLS suite carries
// its own. The constraint tests (partial-unique, projectId/key) run as the
// superuser via the `db` singleton — they assert DB constraints, which bite
// regardless of role.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
  // cascades to project → workflow_status / workflow_transition (all FK the
  // workspace with onDelete: Cascade), so no dedicated truncate is needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

let positionCounter = 0;
function nextPosition(): string {
  // Any strictly-increasing text is a valid fractional-index `position` for
  // these fixtures (we never reorder them). Monotonic base-36 keeps them
  // unique without pulling in the positioning helper.
  positionCounter += 1;
  return `a${positionCounter.toString(36)}`;
}

// Insert a workflow_status directly (no workflowsService yet — the read API
// lands in 2.2.3, the seed in 2.2.2). Runs as the superuser during fixture
// setup, so RLS doesn't bite here.
async function makeStatus(args: {
  workspaceId: string;
  projectId: string;
  key: string;
  category?: StatusCategory;
  isInitial?: boolean;
}): Promise<string> {
  const row = await db.workflowStatus.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      key: args.key,
      label: args.key,
      category: args.category ?? 'todo',
      position: nextPosition(),
      isInitial: args.isInitial ?? false,
    },
  });
  return row.id;
}

async function makeTransition(args: {
  workspaceId: string;
  projectId: string;
  fromStatusId: string;
  toStatusId: string;
}): Promise<string> {
  const row = await db.workflowTransition.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      fromStatusId: args.fromStatusId,
      toStatusId: args.toStatusId,
    },
  });
  return row.id;
}

interface WorkflowTenantFixture {
  workspaceW1Id: string;
  workspaceW2Id: string;
  projectP1Id: string;
  projectP2Id: string;
  // W1: two statuses (todo, done) + one transition.
  statusW1TodoId: string;
  statusW1DoneId: string;
  transitionW1Id: string;
  // W2: two statuses (todo, done) + one transition.
  statusW2TodoId: string;
  statusW2DoneId: string;
  transitionW2Id: string;
}

// Two independent tenants, each a project with a todo→done micro-workflow.
// Users / workspaces / projects are built via the real services so the
// membership + workspace context match production; workflow rows are inserted
// directly (no service yet).
async function makeWorkflowTenants(): Promise<WorkflowTenantFixture> {
  const userA = await usersService.createUser({
    email: 'wf-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'WF Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'wf-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'WF Tenant B',
  });
  const w1 = await workspacesService.createWorkspace({ name: 'WF WS 1', ownerUserId: userA.id });
  const w2 = await workspacesService.createWorkspace({ name: 'WF WS 2', ownerUserId: userB.id });
  // BARE projects (db insert, NOT projectsService.createProject) so the manual
  // status fixtures below aren't shadowed by 2.2.2's auto-seeded default
  // workflow — this suite controls the exact rows under test.
  const p1 = await db.project.create({
    data: { workspaceId: w1.workspace.id, name: 'WF P1', slug: 'wf-rls', identifier: 'WFR' },
  });
  const p2 = await db.project.create({
    data: { workspaceId: w2.workspace.id, name: 'WF P2', slug: 'wf-rls', identifier: 'WFR' },
  });

  const statusW1TodoId = await makeStatus({
    workspaceId: w1.workspace.id,
    projectId: p1.id,
    key: 'todo',
    category: 'todo',
    isInitial: true,
  });
  const statusW1DoneId = await makeStatus({
    workspaceId: w1.workspace.id,
    projectId: p1.id,
    key: 'done',
    category: 'done',
  });
  const transitionW1Id = await makeTransition({
    workspaceId: w1.workspace.id,
    projectId: p1.id,
    fromStatusId: statusW1TodoId,
    toStatusId: statusW1DoneId,
  });

  const statusW2TodoId = await makeStatus({
    workspaceId: w2.workspace.id,
    projectId: p2.id,
    key: 'todo',
    category: 'todo',
    isInitial: true,
  });
  const statusW2DoneId = await makeStatus({
    workspaceId: w2.workspace.id,
    projectId: p2.id,
    key: 'done',
    category: 'done',
  });
  const transitionW2Id = await makeTransition({
    workspaceId: w2.workspace.id,
    projectId: p2.id,
    fromStatusId: statusW2TodoId,
    toStatusId: statusW2DoneId,
  });

  return {
    workspaceW1Id: w1.workspace.id,
    workspaceW2Id: w2.workspace.id,
    projectP1Id: p1.id,
    projectP2Id: p2.id,
    statusW1TodoId,
    statusW1DoneId,
    transitionW1Id,
    statusW2TodoId,
    statusW2DoneId,
    transitionW2Id,
  };
}

/**
 * Run `fn` inside a transaction that (a) optionally binds app.workspace_id and
 * (b) drops to the non-bypass prodect_app role for the duration. The role
 * switch is what makes RLS bite; it reverts at txn end.
 */
async function asAppRole<T>(
  ctx: { workspaceId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('workflow_status RLS — read isolation', () => {
  it('with NO context, prodect_app sees zero workflow_status rows', async () => {
    await makeWorkflowTenants();
    const rows = await asAppRole({}, (tx) => tx.workflowStatus.findMany());
    expect(rows).toEqual([]);
  });

  it("with the W1 context bound, only W1's statuses are visible — never W2's", async () => {
    const fx = await makeWorkflowTenants();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.workflowStatus.findMany(),
    );
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([fx.statusW1TodoId, fx.statusW1DoneId].sort());
    expect(ids).not.toContain(fx.statusW2TodoId);
    expect(ids).not.toContain(fx.statusW2DoneId);
  });

  it('a tenant cannot SELECT a foreign-workspace status (cross-workspace read returns 0 rows)', async () => {
    const fx = await makeWorkflowTenants();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.workflowStatus.findMany({ where: { id: fx.statusW2TodoId } }),
    );
    expect(rows).toEqual([]);
  });
});

describe('workflow_transition RLS — read isolation', () => {
  it('with NO context, prodect_app sees zero workflow_transition rows', async () => {
    await makeWorkflowTenants();
    const rows = await asAppRole({}, (tx) => tx.workflowTransition.findMany());
    expect(rows).toEqual([]);
  });

  it("with the W1 context, only W1's transitions are visible", async () => {
    const fx = await makeWorkflowTenants();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.workflowTransition.findMany(),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([fx.transitionW1Id]);
    expect(ids).not.toContain(fx.transitionW2Id);
  });

  it('a tenant cannot SELECT a foreign-workspace transition', async () => {
    const fx = await makeWorkflowTenants();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.workflowTransition.findMany({ where: { id: fx.transitionW2Id } }),
    );
    expect(rows).toEqual([]);
  });
});

describe('workflow_status RLS — write isolation (WITH CHECK)', () => {
  it('a tenant can INSERT a status for its OWN workspace', async () => {
    const fx = await makeWorkflowTenants();
    const created = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.workflowStatus.create({
        data: {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          key: 'in_progress',
          label: 'In Progress',
          category: 'in_progress',
          position: 'a-own',
        },
      }),
    );
    expect(created.workspaceId).toBe(fx.workspaceW1Id);
  });

  it('a tenant CANNOT INSERT a status carrying a FOREIGN workspaceId (WITH CHECK rejects)', async () => {
    const fx = await makeWorkflowTenants();
    await expect(
      asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
        tx.workflowStatus.create({
          data: {
            workspaceId: fx.workspaceW2Id,
            projectId: fx.projectP2Id,
            key: 'sneaky',
            label: 'Sneaky',
            category: 'todo',
            position: 'a-foreign',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('workflow_status constraints — partial-unique initial status', () => {
  it('a project may have at most one initial status (second initial insert is rejected)', async () => {
    const fx = await makeWorkflowTenants();
    // fx already seeded W1/P1 with an initial `todo`. A second initial status
    // in the same project violates the partial unique index.
    await expect(
      makeStatus({
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        key: 'second_initial',
        isInitial: true,
      }),
    ).rejects.toThrow();
  });

  it('the one-initial rule is scoped per-project — a second project may have its own initial status', async () => {
    // W1/P1 has an initial todo; W2/P2 also has one. Both already coexist in
    // the fixture, proving the index is per-project, not global. Add a fresh
    // project and give it its own initial — also fine.
    await makeWorkflowTenants();
    const userA = await usersService.createUser({
      email: 'wf-extra@example.com',
      password: 'hunter2hunter2',
      name: 'WF Extra',
    });
    const w3 = await workspacesService.createWorkspace({ name: 'WF WS 3', ownerUserId: userA.id });
    const p3 = await db.project.create({
      data: { workspaceId: w3.workspace.id, name: 'WF P3', slug: 'wf-rls', identifier: 'WFR' },
    });
    const id = await makeStatus({
      workspaceId: w3.workspace.id,
      projectId: p3.id,
      key: 'todo',
      isInitial: true,
    });
    expect(id).toBeTruthy();
  });

  it('many NON-initial statuses are allowed in one project (partial index ignores is_initial = false)', async () => {
    const fx = await makeWorkflowTenants();
    const a = await makeStatus({
      workspaceId: fx.workspaceW1Id,
      projectId: fx.projectP1Id,
      key: 'blocked',
    });
    const b = await makeStatus({
      workspaceId: fx.workspaceW1Id,
      projectId: fx.projectP1Id,
      key: 'in_review',
    });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });
});

describe('workflow_status constraints — per-project key uniqueness', () => {
  it('duplicate (projectId, key) is rejected', async () => {
    const fx = await makeWorkflowTenants();
    // fx already has a `todo` in W1/P1.
    await expect(
      makeStatus({ workspaceId: fx.workspaceW1Id, projectId: fx.projectP1Id, key: 'todo' }),
    ).rejects.toThrow();
  });

  it('the SAME key is allowed in two different projects', async () => {
    await makeWorkflowTenants();
    // Both P1 and P2 already carry a `todo` key in the fixture — distinct
    // projects, so no collision. Assert both are present (as superuser).
    const count = await db.workflowStatus.count({ where: { key: 'todo' } });
    expect(count).toBe(2);
  });
});
