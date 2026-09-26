import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { PERMISSION_CATALOG, type PermissionKey } from '@/lib/permissions/catalog';
import { CUSTOM_ROLE_TIER } from '@/lib/permissions/builtinRoles';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { DispatchRunNotFoundError } from '@/lib/dispatchRuns/errors';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER, expandStoredGrant } from '@/lib/tokens/grant';
import { canOfferNavDestination, PROJECT_NAV_ACCESS } from '@/lib/settings/projectNavAccess';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// STORY MOTIR-6179's INTEGRATION GATE (Subtask MOTIR-6336).
//
// Each child proved its own seam with its own fixture. This file walks the
// ASSEMBLED path — a real membership → `resolvePermissions` → each room's read
// and nav door — against the real datastore, with NO mocked permission set
// (`getPermissions` / `resolvePermissions` are never stubbed here).
//
// ⚠️ THE FIXTURE IS THE CASE. Every count assertion runs against a population in
// which the actor's own records and the project's DIFFER (the owner holds two
// records of every kind the actors do not), so a read that forgot to scope and a
// read that scoped cannot return the same number — the admitting-context rule
// (`phase-author.md`) made this gate's standing precondition.

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-gate' })),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { planSessionsService } = await import('@/lib/services/planSessionsService');

type Actor = 'member' | 'viewer' | 'actor' | 'browseOnly';
const ACTORS: readonly Actor[] = ['member', 'viewer', 'actor', 'browseOnly'];

/** The custom role that ACTS in all three rooms and holds NO view-any key. */
const ACTS_WITHOUT_VIEW: PermissionKey[] = [
  'project:browse',
  'ai:plan',
  'work_item:edit',
  'ai:decide_plan',
];

let fx: WorkItemFixture;
let seq = 0;
const ctx = {} as Record<Actor, ServiceContext>;
let storyId: string;
let cardKey: string;
/** The owner's records — the half of the population no actor owns. */
const owner = { plans: [] as string[], runs: [] as string[] };
/** Records per actor, by kind (`plans` holds plan ids, `runs` run ids). */
const own = {} as Record<Actor, { plans: string[]; runs: string[]; gates: number }>;

async function seat(role: 'member' | 'viewer'): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: `gate-${role}-${seq++}@example.com`,
    password: 'correct-horse-battery-staple',
    name: `Gate ${role}`,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role,
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

async function customRole(permissions: string[]) {
  return adminDb.projectRoleDefinition.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: `Gate role ${seq++}`,
      permissions,
    },
  });
}

async function seatCustom(permissions: string[]): Promise<ServiceContext> {
  const reader = await seat('member');
  const role = await customRole(permissions);
  await adminDb.$transaction((tx) =>
    projectMembershipRepository.setRoleDefinition(
      reader.userId,
      fx.projectId,
      { roleDefinitionId: role.id, role: CUSTOM_ROLE_TIER },
      tx,
    ),
  );
  return reader;
}

async function plan(by: ServiceContext, title: string): Promise<string> {
  const created = await plansService.createPlan(
    fx.projectId,
    { title, session: { origin: 'mcp' }, authorSource: 'mcp', createdById: by.userId },
    by,
  );
  return created.id;
}

async function run(by: ServiceContext): Promise<string> {
  const opened = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'batch',
      cards: [{ key: cardKey, disposition: 'queued' as const }],
    },
    by,
  );
  return opened.run.id;
}

/** An awaiting design gate routed (by assignee) to `assigneeId`. */
async function gate(assigneeId: string): Promise<void> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: storyId, title: `Gate ${seq++}` },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId } });
  await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind: 'design_result',
      subjectId: `ev-${item.id}`,
    },
  });
}

const home = (c: ServiceContext) => ({ ...c, projectId: fx.projectId });
const held = (c: ServiceContext) => projectAccessService.getPermissions(fx.projectId, c);

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Rooms gate' },
    fx.ctx,
  );
  storyId = story.id;
  cardKey = (
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'A card' },
      fx.ctx,
    )
  ).identifier;

  ctx.member = await seat('member');
  ctx.viewer = await seat('viewer');
  ctx.actor = await seatCustom(ACTS_WITHOUT_VIEW);
  ctx.browseOnly = await seatCustom(['project:browse']);

  owner.plans = [await plan(fx.ctx, 'Owner plan 1'), await plan(fx.ctx, 'Owner plan 2')];
  owner.runs = [await run(fx.ctx), await run(fx.ctx)];
  await gate(fx.ownerId);
  await gate(fx.ownerId);

  for (const a of ACTORS) own[a] = { plans: [], runs: [], gates: 0 };
  for (const a of ['member', 'actor'] as const) {
    own[a].plans.push(await plan(ctx[a], `${a} plan`));
    own[a].runs.push(await run(ctx[a]));
    await gate(ctx[a].userId);
    own[a].gates += 1;
  }
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const TOTAL = { plans: 4, runs: 4, gates: 4 };

/** What each actor must be SERVED for a `project` request, and whether a door opens. */
const EXPECT: Record<Actor, { scope: 'project' | 'mine'; views: string[]; door: boolean }> = {
  member: { scope: 'project', views: ['mine', 'project'], door: true },
  viewer: { scope: 'project', views: ['project'], door: true },
  actor: { scope: 'mine', views: ['mine'], door: true },
  browseOnly: { scope: 'mine', views: [], door: false },
};

describe('four actors × the PLANS room, one resolver', () => {
  it.each(ACTORS)('%s', async (a) => {
    const want = EXPECT[a];
    const page = await planSessionsService.listSessions(fx.projectId, ctx[a], { view: 'project' });
    expect(page.scope).toBe(want.scope);
    expect(page.sessions).toHaveLength(
      want.scope === 'project' ? TOTAL.plans : own[a].plans.length,
    );
    // The fixture discriminates: the scoped and unscoped answers differ for everyone.
    expect(own[a].plans.length).not.toBe(TOTAL.plans);
    expect((await planSessionsService.roomAccess(fx.projectId, ctx[a])).views).toEqual(want.views);

    const colleague = plansService.getPlanForReader(owner.plans[0]!, ctx[a]);
    if (want.scope === 'project')
      await expect(colleague).resolves.toMatchObject({ id: owner.plans[0] });
    else await expect(colleague).rejects.toBeInstanceOf(PlanNotFoundError);

    expect(canOfferNavDestination('/plans', await held(ctx[a]))).toBe(want.door);
  });
});

describe('four actors × the RUNS room, one resolver', () => {
  it.each(ACTORS)('%s', async (a) => {
    const want = EXPECT[a];
    const page = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 50, view: 'project' },
      ctx[a],
    );
    expect(page.scope).toBe(want.scope);
    expect(page.runs).toHaveLength(want.scope === 'project' ? TOTAL.runs : own[a].runs.length);
    expect(own[a].runs.length).not.toBe(TOTAL.runs);
    expect((await dispatchRunService.roomAccess(fx.projectIdentifier, ctx[a])).views).toEqual(
      want.views,
    );

    const colleague = dispatchRunService.getRunDetail(owner.runs[0]!, ctx[a]);
    if (want.scope === 'project')
      await expect(colleague).resolves.toMatchObject({ id: owner.runs[0] });
    else await expect(colleague).rejects.toBeInstanceOf(DispatchRunNotFoundError);

    expect(canOfferNavDestination('/runs', await held(ctx[a]))).toBe(want.door);
  });
});

describe('four actors × the APPROVALS room, one resolver', () => {
  it.each(ACTORS)('%s', async (a) => {
    const want = EXPECT[a];
    const page = await approvalGatesService.listRecords(home(ctx[a]), {
      view: 'project',
      limit: 50,
    });
    expect(page.scope).toBe(want.scope);
    expect(page.views).toEqual(want.views);
    const count = page.sections.awaiting.total + page.sections.decided.total;
    expect(count).toBe(want.scope === 'project' ? TOTAL.gates : own[a].gates);
    expect(own[a].gates).not.toBe(TOTAL.gates);
    // A colleague's record is ABSENT from a scoped read — the room has no by-id
    // read, so absence from the served list is its not-found.
    if (want.scope === 'mine') expect(count).toBeLessThan(TOTAL.gates);

    expect(canOfferNavDestination('/approvals', await held(ctx[a]))).toBe(want.door);
  });

  it('the DEFAULT rule — a two-view reader lands on Mine only when Mine has rows', async () => {
    expect((await approvalGatesService.listRecords(home(ctx.member))).scope).toBe('mine');
    const fresh = await seat('member');
    expect((await approvalGatesService.listRecords(home(fresh))).scope).toBe('project');
  });
});

describe('a bearer token narrows the rooms by its GRANT, whatever the role holds', () => {
  it('a Member’s token minted without the view keys is served Mine in every room', async () => {
    const narrowed: ServiceContext = {
      ...ctx.member,
      tokenGrant: ['project:browse', 'work_item:edit', 'ai:plan', 'ai:decide_plan'],
    };
    expect(
      (await planSessionsService.listSessions(fx.projectId, narrowed, { view: 'project' })).scope,
    ).toBe('mine');
    expect(
      (
        await dispatchRunService.listRunsForProject(
          fx.projectIdentifier,
          { take: 50, view: 'project' },
          narrowed,
        )
      ).scope,
    ).toBe('mine');
    expect(
      (await approvalGatesService.listRecords(home(narrowed), { view: 'project' })).scope,
    ).toBe('mine');
    await expect(plansService.getPlanForReader(owner.plans[0]!, narrowed)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
  });
});

describe('the MIGRATION keeps every persisted grant’s reach (before = after)', () => {
  const MIGRATION = path.join(
    process.cwd(),
    'prisma/migrations/20260925170000_room_view_keys_for_custom_roles/migration.sql',
  );
  const runMigration = async () => {
    const statements = readFileSync(MIGRATION, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) await adminDb.$executeRawUnsafe(statement);
  };

  it('a custom role and a pre-marker token that browse still read the WHOLE Plans and Runs rooms', async () => {
    // BEFORE the read cards enforced the keys, `project:browse` alone read every
    // plan and every run — that is the reach to keep. This role was written with
    // browse and no view key, as every pre-story custom role was.
    const legacy = await seatCustom(['project:browse']);
    const before = await planSessionsService.listSessions(fx.projectId, legacy, {
      view: 'project',
    });
    expect(before.scope).toBe('mine'); // the un-migrated row has lost the room…

    await runMigration();

    const plans = await planSessionsService.listSessions(fx.projectId, legacy, { view: 'project' });
    expect(plans.scope).toBe('project'); // …and the migration gives it back
    expect(plans.sessions).toHaveLength(TOTAL.plans);
    const runs = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 50, view: 'project' },
      legacy,
    );
    expect(runs).toMatchObject({ scope: 'project' });
    expect(runs.runs).toHaveLength(TOTAL.runs);

    // The TOKEN half is read-time, never a migration: a chosen grant stored
    // before the mint path wrote its marker reads forward…
    const stored = ['project:browse', 'work_item:edit'];
    const forward = expandStoredGrant(stored, { projectId: fx.projectId }).grant;
    const asMember: ServiceContext = { ...ctx.member, tokenGrant: forward };
    expect(
      (await planSessionsService.listSessions(fx.projectId, asMember, { view: 'project' })).scope,
    ).toBe('project');
    expect(
      (
        await dispatchRunService.listRunsForProject(
          fx.projectIdentifier,
          { take: 50, view: 'project' },
          asMember,
        )
      ).runs,
    ).toHaveLength(TOTAL.runs);

    // …and THE MAPPING IS LOAD-BEARING: the same stored keys WITHOUT the forward
    // read (a marked grant) lose both rooms. Remove the mapping and the assertion
    // above fails exactly as this one passes.
    const unmapped = expandStoredGrant([...stored, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER], {
      projectId: fx.projectId,
    }).grant;
    expect(
      (
        await planSessionsService.listSessions(
          fx.projectId,
          { ...ctx.member, tokenGrant: unmapped },
          { view: 'project' },
        )
      ).scope,
    ).toBe('mine');
  });
});

describe('the writer → consumer seams', () => {
  it('a plan authored through `add_plan_items` by an author WITHOUT `plan:view_any` is in their Mine and not-found to another such author', async () => {
    // The authoring door asserts `ai:view_plan` (the AUTHOR key); neither author
    // holds the room's VIEW key.
    const AUTHOR = [...ACTS_WITHOUT_VIEW, 'ai:view_plan'];
    const author = await seatCustom(AUTHOR);
    const other = await seatCustom(AUTHOR);
    const planId = await plan(author, 'Authored through the doors');
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'A story', kind: 'story' } }],
      author,
    );
    const mine = await planSessionsService.listSessions(fx.projectId, author, { view: 'project' });
    expect(mine.scope).toBe('mine');
    const session = (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).sessionId;
    expect(mine.sessions.map((s) => s.id)).toEqual([session]);
    await expect(plansService.getPlanForReader(planId, other)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
  });

  it('a run opened under CLI_TOKEN_GRANT is listed for its opener', async () => {
    const cli: ServiceContext = { ...ctx.member, tokenGrant: [...CLI_TOKEN_GRANT] };
    const runId = await run(cli);
    const page = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 50, view: 'mine' },
      cli,
    );
    expect(page.runs.map((r) => r.id)).toContain(runId);
  });
});

describe('contract guards', () => {
  it('every key the three rooms assert is enforced', () => {
    for (const key of ['approval:view_any', 'plan:view_any', 'run:view_any'] as const) {
      expect(PERMISSION_CATALOG[key].enforcement, key).toBe('enforced');
    }
  });

  it('`ai:view_plan` gates every AUTHORING door and no read', () => {
    for (const tool of [
      'add_plan_items',
      'update_plan_item',
      'update_plan_proposal',
      'withdraw_plan_proposal',
      'update_plan',
    ] as const) {
      expect(TOOL_PERMISSIONS[tool], tool).toBe('ai:view_plan');
    }
    for (const read of ['get_plan', 'get_plan_status', 'validate_plan'] as const) {
      expect(TOOL_PERMISSIONS[read], read).toBe('project:browse');
    }
  });

  it('the three room doors are any-of requirements over their view key and act keys', () => {
    const rows = new Map(PROJECT_NAV_ACCESS.map((row) => [row.href, row.requires]));
    for (const [href, key] of [
      ['/plans', 'plan:view_any'],
      ['/approvals', 'approval:view_any'],
      ['/runs', 'run:view_any'],
    ] as const) {
      const requires = rows.get(href);
      expect(typeof requires === 'object' && requires.anyOf.includes(key), href).toBe(true);
    }
  });
});
