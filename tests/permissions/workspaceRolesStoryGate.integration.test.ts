import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceRole } from '@/generated/prisma/client';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { adminDb } from '../helpers/adminDb';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — roles move to the workspace (Story MOTIR-6168 · MOTIR-6467)
// ═══════════════════════════════════════════════════════════════════════════
//
// Every card of the story shipped its own tests, each building the input it
// expects. This file drives the ASSEMBLED story through its real doors against
// real Postgres, so a join between two cards cannot drift unseen:
//
//   * THE MATRIX — Manager, Member, Viewer and a custom role without
//     `run:view_any`, in an OPEN project they were never added to and a PRIVATE
//     one they were, each calling one real ROUTE per key domain. Allow or deny
//     must equal the role's key set (`WORKSPACE_ROLE_PERMISSIONS`, or the custom
//     role's keys) — on both levels, since `open` and an added `private` subtract
//     nothing. Then the role is changed through `PATCH …/members/{userId}` and
//     the SAME calls must flip in BOTH projects: the role is written once, on the
//     workspace, and read everywhere.
//   * THE SEAMS — a role authored through the roles route and assigned through
//     the member route is what the resolver returns; a role deleted with reassign
//     leaves its holders resolving as the target; a report row the migration
//     wrote is what the Members page's server read returns.
//   * CROSS-TENANT — a Manager of A is 404 on B's roles and members routes.
//
// Only the session doors are mocked (the test has no cookies); every gate is the
// shipped one. The migration's half of the gate is
// `tests/migrations/workspaceRoleStoryGate.test.ts`; the architecture guards are
// `tests/permissions/workspaceRoleArchitecture.test.ts`.

const ctxRef = { current: null as WorkspaceContext | null };
const activeProject = { current: null as { projectId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getSession: async () => (ctxRef.current ? { user: { id: ctxRef.current.userId } } : null),
  };
});
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return {
    ...actual,
    getActiveProject: async () =>
      ctxRef.current && activeProject.current
        ? { ...ctxRef.current, projectId: activeProject.current.projectId }
        : null,
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const estimateRoute = await import('@/app/api/work-items/[id]/estimate/route');
const commentsRoute = await import('@/app/api/work-items/[id]/comments/route');
const sprintsRoute = await import('@/app/api/sprints/route');
const projectRoute = await import('@/app/api/projects/[key]/route');
const plansRoute = await import('@/app/api/work-items/[id]/plans/route');
const runsRoute = await import('@/app/api/work-items/[id]/dispatch-runs/route');
const memberRoute = await import('@/app/api/workspaces/[workspaceId]/members/[userId]/route');
const rolesRoute = await import('@/app/api/workspaces/[workspaceId]/roles/route');
const roleRoute = await import('@/app/api/workspaces/[workspaceId]/roles/[roleId]/route');
const { WORKSPACE_ROLE_PERMISSIONS, ROLE_GATED_PERMISSIONS } =
  await import('@/lib/permissions/builtinRoles');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { projectMembersService } = await import('@/lib/services/projectMembersService');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { roleMigrationReportService } = await import('@/lib/services/roleMigrationReportService');
const { createTestWorkItem } = await import('../fixtures');
const { truncateAuthTables } = await import('../helpers/db');

beforeEach(async () => {
  ctxRef.current = null;
  activeProject.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
const PASSWORD = 'hunter2hunter2';

function user(label: string) {
  return usersService.createUser({
    email: `wrsg-${label}-${seq++}@ex.com`,
    password: PASSWORD,
    name: label,
  });
}

/** The custom role of the matrix — it reads plans and comments, and may NOT read others' runs. */
const REVIEWER_KEYS: PermissionKey[] = [
  'project:browse',
  'report:view',
  'comment:add',
  'ai:view_plan',
  'plan:view_any',
];

interface ProjectFx {
  id: string;
  key: string;
  itemId: string;
  itemKey: string;
  runId: string;
}

interface Fixture {
  workspaceId: string;
  managerId: string;
  managerCtx: WorkspaceContext;
  subjectId: string;
  subjectCtx: WorkspaceContext;
  reviewerRoleId: string;
  open: ProjectFx;
  priv: ProjectFx;
}

async function project(
  workspaceId: string,
  managerId: string,
  name: string,
  identifier: string,
): Promise<ProjectFx> {
  const p = await projectsService.createProject({
    workspaceId,
    actorUserId: managerId,
    name,
    identifier,
  });
  const ctx = { userId: managerId, workspaceId };
  const item = await createTestWorkItem(
    {
      owner: null as never,
      workspace: null as never,
      project: p,
      ownerId: managerId,
      workspaceId,
      projectId: p.id,
      projectIdentifier: p.identifier,
      ctx,
    },
    { kind: 'task', title: `Item in ${name}` },
  );
  // A run the MANAGER started on the item: another person sees it only with
  // `run:view_any` (otherwise their list is scoped to runs they started).
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId,
      projectId: p.id,
      command: 'run_scope',
      scopeLabel: item.identifier,
      createdById: managerId,
    },
  });
  await adminDb.dispatchRunCard.create({
    data: {
      workspaceId,
      dispatchRunId: run.id,
      workItemId: item.id,
      workItemKey: item.identifier,
      position: 0,
    },
  });
  return { id: p.id, key: p.identifier, itemId: item.id, itemKey: item.identifier, runId: run.id };
}

/**
 * One workspace, a Manager, the SUBJECT whose role the matrix varies, a custom
 * role, and two projects: OPEN (the subject was never added) and PRIVATE (the
 * subject was added — which grants nothing by itself).
 */
async function build(tag = String(seq++)): Promise<Fixture> {
  const manager = await user(`manager${tag}`);
  const { workspace } = await workspacesService.createWorkspace({
    name: `WRSG ${tag}`,
    ownerUserId: manager.id,
  });
  const subject = await user(`subject${tag}`);
  await workspacesService.addMember({ userId: subject.id, workspaceId: workspace.id });
  const managerCtx = { userId: manager.id, workspaceId: workspace.id };

  const open = await project(workspace.id, manager.id, 'Open', `OP${tag}`.slice(0, 8));
  const priv = await project(workspace.id, manager.id, 'Private', `PV${tag}`.slice(0, 8));
  await adminDb.project.update({ where: { id: priv.id }, data: { accessLevel: 'private' } });
  await projectMembersService.addMember({
    key: priv.key,
    actorUserId: manager.id,
    ctx: managerCtx,
    targetUserId: subject.id,
  });

  const reviewer = await adminDb.workspaceRoleDefinition.create({
    data: { workspaceId: workspace.id, name: 'Reviewer', permissions: REVIEWER_KEYS },
  });

  return {
    workspaceId: workspace.id,
    managerId: manager.id,
    managerCtx,
    subjectId: subject.id,
    subjectCtx: { userId: subject.id, workspaceId: workspace.id },
    reviewerRoleId: reviewer.id,
    open,
    priv,
  };
}

// ── The six probes: one real route per key domain ────────────────────────────
//
// Each names the ONE key its route gates on, and answers whether the call was
// ADMITTED. A refusal is the route's own 403 (or, for a record read, an answer
// that leaves the other person's record out — the shape the shipped read has).

interface Probe {
  domain: string;
  key: PermissionKey;
  call: (p: ProjectFx, n: number) => Promise<boolean>;
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function admitted(res: Response): Promise<boolean> {
  if (res.status >= 200 && res.status < 300) return true;
  if (res.status === 403) return false;
  throw new Error(`unexpected ${res.status}: ${await res.text()}`);
}

const PROBE_KEYS = [
  'work_item:edit',
  'comment:add',
  'sprint:manage',
  'project:administer',
  'ai:view_plan',
  'run:view_any',
] as const;

const PROBES: Probe[] = [
  {
    domain: 'a work item edit',
    key: 'work_item:edit',
    call: async (p, n) =>
      admitted(
        await estimateRoute.PATCH(
          new Request(`http://x/api/work-items/${p.itemId}/estimate`, json({ points: n }, 'PATCH')),
          { params: Promise.resolve({ id: p.itemId }) },
        ),
      ),
  },
  {
    domain: 'a comment',
    key: 'comment:add',
    call: async (p, n) =>
      admitted(
        await commentsRoute.POST(
          new Request(`http://x/api/work-items/${p.itemId}/comments`, json({ bodyMd: `c${n}` })),
          { params: Promise.resolve({ id: p.itemId }) },
        ),
      ),
  },
  {
    domain: 'a sprint change',
    key: 'sprint:manage',
    call: async (p, n) => {
      activeProject.current = { projectId: p.id };
      return admitted(
        await sprintsRoute.POST(new Request('http://x/api/sprints', json({ name: `S${n}` }))),
      );
    },
  },
  {
    domain: 'a settings change',
    key: 'project:administer',
    call: async (p, n) =>
      admitted(
        await projectRoute.PATCH(
          new Request(`http://x/api/projects/${p.key}`, json({ name: `Renamed ${n}` }, 'PATCH')),
          { params: Promise.resolve({ key: p.key }) },
        ),
      ),
  },
  {
    domain: 'a plan read at project scope',
    key: 'ai:view_plan',
    call: async (p) =>
      admitted(
        await plansRoute.GET(new Request(`http://x/api/work-items/${p.itemId}/plans`), {
          params: Promise.resolve({ id: p.itemId }),
        }),
      ),
  },
  {
    domain: 'a run read at project scope',
    key: 'run:view_any',
    call: async (p) => {
      const res = await runsRoute.GET(
        new Request(`http://x/api/work-items/${p.itemKey}/dispatch-runs`),
        { params: Promise.resolve({ id: p.itemKey }) },
      );
      expect(res.status).toBe(200);
      const { runs } = (await res.json()) as { runs: { id: string }[] };
      return runs.some((r) => r.id === p.runId);
    },
  },
];

type Subject = WorkspaceRole | 'reviewer';

/**
 * What each role may do, per probe — written OUT, not derived from
 * `WORKSPACE_ROLE_PERMISSIONS`. An expectation computed from the constant under
 * test agrees with any edit to it; this table is what makes the matrix fail when
 * a role is widened (giving `viewer` `work_item:edit` turns the viewer row red —
 * proven once on MOTIR-6467). The consistency test below keeps the table and the
 * constant honest with each other in the direction that matters: a change to
 * either is a deliberate change to both.
 */
const MATRIX: Record<Subject, Record<PermissionKey & (typeof PROBE_KEYS)[number], boolean>> = {
  manager: {
    'work_item:edit': true,
    'comment:add': true,
    'sprint:manage': true,
    'project:administer': true,
    'ai:view_plan': true,
    'run:view_any': true,
  },
  member: {
    'work_item:edit': true,
    'comment:add': true,
    'sprint:manage': true,
    'project:administer': false,
    'ai:view_plan': true,
    'run:view_any': true,
  },
  viewer: {
    'work_item:edit': false,
    'comment:add': false,
    'sprint:manage': false,
    'project:administer': false,
    'ai:view_plan': false,
    'run:view_any': true,
  },
  reviewer: {
    'work_item:edit': false,
    'comment:add': true,
    'sprint:manage': false,
    'project:administer': false,
    'ai:view_plan': true,
    'run:view_any': false,
  },
};

function expectedKeys(role: Subject): ReadonlySet<PermissionKey> {
  if (role === 'reviewer') return new Set(REVIEWER_KEYS);
  if (role === 'manager') return new Set(ROLE_GATED_PERMISSIONS);
  return WORKSPACE_ROLE_PERMISSIONS[role];
}

function expected(role: Subject): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const level of ['open', 'private']) {
    for (const probe of PROBES) {
      out[`${probe.domain}@${level}`] = MATRIX[role][probe.key as (typeof PROBE_KEYS)[number]];
    }
  }
  return out;
}

let callSeq = 0;

/** Every probe, in both projects, as the subject: `domain@level → admitted`. */
async function observe(fx: Fixture): Promise<Record<string, boolean>> {
  ctxRef.current = fx.subjectCtx;
  const out: Record<string, boolean> = {};
  for (const [level, p] of [
    ['open', fx.open],
    ['private', fx.priv],
  ] as const) {
    for (const probe of PROBES) out[`${probe.domain}@${level}`] = await probe.call(p, callSeq++);
  }
  return out;
}

/** The role change, through the REAL member route, as the Manager. */
async function setRole(fx: Fixture, role: Subject): Promise<void> {
  ctxRef.current = fx.managerCtx;
  const body = role === 'reviewer' ? { roleDefinitionId: fx.reviewerRoleId } : { role };
  const res = await memberRoute.PATCH(
    new Request(`http://x/api/workspaces/${fx.workspaceId}/members/${fx.subjectId}`, {
      ...json(body, 'PATCH'),
    }),
    { params: Promise.resolve({ workspaceId: fx.workspaceId, userId: fx.subjectId }) },
  );
  expect(res.status, await res.clone().text()).toBe(200);
}

describe('the role × project matrix, through the routes', () => {
  it('the written-out table agrees with the shipped key sets (a change to one is a change to both)', () => {
    for (const role of ['manager', 'member', 'viewer', 'reviewer'] as const) {
      for (const key of PROBE_KEYS)
        expect([role, key, expectedKeys(role).has(key)]).toEqual([role, key, MATRIX[role][key]]);
    }
  });

  it('the probes between them separate every role — no two rows of the matrix are equal', () => {
    // Otherwise a flip could pass without the role having changed anything.
    const rows = (['manager', 'member', 'viewer', 'reviewer'] as const).map((r) =>
      JSON.stringify(expected(r)),
    );
    expect(new Set(rows).size).toBe(rows.length);
  });

  it.each(['manager', 'member', 'viewer', 'reviewer'] as const)(
    'as %s, every route admits exactly the keys the role holds, in the open AND the private project',
    async (role) => {
      const fx = await build();
      await setRole(fx, role);
      expect(await observe(fx)).toEqual(expected(role));
    },
  );

  it.each([
    ['member', 'viewer'],
    ['viewer', 'reviewer'],
    ['reviewer', 'manager'],
    ['manager', 'member'],
  ] as const)(
    'changing %s → %s through the member route flips the same calls in BOTH projects',
    async (from, to) => {
      const fx = await build();
      await setRole(fx, from);
      const before = await observe(fx);
      expect(before).toEqual(expected(from));
      await setRole(fx, to);
      const after = await observe(fx);
      expect(after).toEqual(expected(to));
      // And the flip is the SAME in both projects: the role lives on the workspace.
      const flipped = (level: string) =>
        PROBES.filter((p) => before[`${p.domain}@${level}`] !== after[`${p.domain}@${level}`]).map(
          (p) => p.domain,
        );
      expect(flipped('open')).toEqual(flipped('private'));
      expect(flipped('open').length).toBeGreaterThan(0);
    },
  );
});

describe('the writer → consumer seams', () => {
  it('a role authored through the roles route and assigned through the member route is what the resolver returns', async () => {
    const fx = await build();
    ctxRef.current = fx.managerCtx;
    const keys: PermissionKey[] = ['project:browse', 'report:view', 'sprint:manage'];
    const res = await rolesRoute.POST(
      new Request(`http://x/api/workspaces/${fx.workspaceId}/roles`, {
        ...json({ name: 'Sprinter', basedOn: 'viewer', permissions: keys }),
      }),
      { params: Promise.resolve({ workspaceId: fx.workspaceId }) },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const {
      role: { id },
    } = (await res.json()) as { role: { id: string } };

    const assign = await memberRoute.PATCH(
      new Request(`http://x/api/workspaces/${fx.workspaceId}/members/${fx.subjectId}`, {
        ...json({ roleDefinitionId: id }, 'PATCH'),
      }),
      { params: Promise.resolve({ workspaceId: fx.workspaceId, userId: fx.subjectId }) },
    );
    expect(assign.status).toBe(200);

    for (const p of [fx.open, fx.priv]) {
      const held = await projectAccessService.getPermissions(p.id, fx.subjectCtx);
      expect([...held].sort()).toEqual([...keys].sort());
    }
  });

  it('a role deleted with reassign leaves its holders resolving as the target', async () => {
    const fx = await build();
    await setRole(fx, 'reviewer');
    ctxRef.current = fx.managerCtx;
    const res = await roleRoute.DELETE(
      new Request(
        `http://x/api/workspaces/${fx.workspaceId}/roles/${fx.reviewerRoleId}?reassignToRole=viewer`,
        { method: 'DELETE' },
      ),
      { params: Promise.resolve({ workspaceId: fx.workspaceId, roleId: fx.reviewerRoleId }) },
    );
    expect(res.status).toBe(204);
    for (const p of [fx.open, fx.priv]) {
      const held = await projectAccessService.getPermissions(p.id, fx.subjectCtx);
      expect([...held].sort()).toEqual([...WORKSPACE_ROLE_PERMISSIONS.viewer].sort());
    }
    // …and through a route, not only the resolver.
    expect(await observe(fx)).toEqual(expected('viewer'));
  });

  it('a report row the migration wrote is what the Members page’s server read returns', async () => {
    const fx = await build();
    const row = await adminDb.roleMigrationReport.create({
      data: {
        workspaceId: fx.workspaceId,
        userId: fx.subjectId,
        beforeJson: {
          workspaceRole: 'member',
          projects: [{ projectKey: fx.priv.key, role: 'viewer' }],
        },
        afterRole: 'viewer',
        reason: 'narrowest_kept',
      },
    });
    const page = await roleMigrationReportService.firstPageForViewer(fx.workspaceId, fx.managerId);
    expect(page?.total).toBe(1);
    expect(page?.entries[0]).toMatchObject({
      id: row.id,
      userId: fx.subjectId,
      afterRole: 'viewer',
      reason: 'narrowest_kept',
      before: { workspaceRole: 'member', projects: [{ projectKey: fx.priv.key, role: 'viewer' }] },
    });
  });
});

describe('cross-tenant', () => {
  it('a Manager of workspace A is 404 on B’s roles and members routes', async () => {
    const a = await build();
    const b = await build();
    ctxRef.current = a.managerCtx;

    const roles = await rolesRoute.GET(
      new Request(`http://x/api/workspaces/${b.workspaceId}/roles`),
      {
        params: Promise.resolve({ workspaceId: b.workspaceId }),
      },
    );
    expect(roles.status).toBe(404);

    const authored = await rolesRoute.POST(
      new Request(`http://x/api/workspaces/${b.workspaceId}/roles`, {
        ...json({ name: 'Intruder', basedOn: 'viewer', permissions: ['project:browse'] }),
      }),
      { params: Promise.resolve({ workspaceId: b.workspaceId }) },
    );
    expect(authored.status).toBe(404);

    const member = await memberRoute.PATCH(
      new Request(`http://x/api/workspaces/${b.workspaceId}/members/${b.subjectId}`, {
        ...json({ role: 'manager' }, 'PATCH'),
      }),
      { params: Promise.resolve({ workspaceId: b.workspaceId, userId: b.subjectId }) },
    );
    expect(member.status).toBe(404);

    // And nothing moved in B.
    const row = await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: b.subjectId, workspaceId: b.workspaceId } },
    });
    expect(row.workspaceRole).toBe('member');
    expect(await adminDb.workspaceRoleDefinition.count({ where: { name: 'Intruder' } })).toBe(0);
  });
});
