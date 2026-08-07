import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { boardsService } from '@/lib/services/boardsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { componentsService } from '@/lib/services/componentsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { estimationService } from '@/lib/services/estimationService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// THE STORY TEST GATE for MOTIR-2256 (Subtask MOTIR-2302) — the SEAM half, against
// real Postgres.
//
// Each domain card tests its own service. What no card can test is the thing this
// story actually changed: that ONE resolution now answers for all of them, and
// answers the same way. So this walks every administrative domain through the same
// four questions, with real membership rows and the real resolution:
//
//   * a project ADMIN passes,
//   * a project MEMBER is refused 403 carrying the key it asked for,
//   * a NON-BROWSER gets 404 and not 403 — the no-existence-leak posture, which is
//     a security property and the one most easily lost one domain at a time,
//   * a WORKSPACE OWNER passes on every access level (the always-pass rail).
//
// And the direction a coverage number is blindest to: the READS the domain cards
// deliberately left alone are asserted reachable BY A MEMBER. Over-tightening is
// the failure this story could ship while every gate test stayed green.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Scenario {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  ownerCtx: WorkspaceContext;
  adminCtx: WorkspaceContext;
  memberCtx: WorkspaceContext;
  outsiderCtx: WorkspaceContext;
  boardId: string;
  columnId: string;
}

/**
 * A PRIVATE project with one actor per role. `private` is the level that separates
 * the two refusals: a workspace member with no project membership cannot browse
 * it, so they must get the 404 arm, while a project member browses and gets 403.
 */
async function scenario(slug: string): Promise<Scenario> {
  const owner = await usersService.createUser({
    email: `sg-owner-${slug}@ex.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `SG ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `SG Project ${slug}`,
  });
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };

  async function actor(label: string, projectRole?: 'admin' | 'member'): Promise<WorkspaceContext> {
    const u = await usersService.createUser({
      email: `sg-${label}-${slug}@ex.com`,
      password: PASSWORD,
      name: label,
    });
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    if (projectRole) {
      await db.projectMembership.create({
        data: {
          userId: u.id,
          projectId: project.id,
          workspaceId: workspace.id,
          role: projectRole,
        },
      });
    }
    return { userId: u.id, workspaceId: workspace.id };
  }

  const adminCtx = await actor('admin', 'admin');
  const memberCtx = await actor('member', 'member');
  const outsiderCtx = await actor('outsider');

  await db.project.update({ where: { id: project.id }, data: { accessLevel: 'private' } });

  const board = await db.board.findFirstOrThrow({ where: { projectId: project.id } });
  const column = await db.boardColumn.findFirstOrThrow({
    where: { boardId: board.id },
    orderBy: { position: 'asc' },
  });

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    ownerCtx,
    adminCtx,
    memberCtx,
    outsiderCtx,
    boardId: board.id,
    columnId: column.id,
  };
}

/** One representative WRITE per administrative domain, and the key it must ask for. */
const DOMAIN_WRITES: {
  domain: string;
  key: PermissionKey;
  write: (s: Scenario, ctx: WorkspaceContext) => Promise<unknown>;
}[] = [
  {
    domain: 'member',
    key: 'member:manage',
    write: async (s, ctx) => {
      const target = await usersService.createUser({
        email: `sg-target-${ctx.userId.slice(-6)}@ex.com`,
        password: PASSWORD,
        name: 'Target',
      });
      await workspacesService.addMember({ userId: target.id, workspaceId: s.workspaceId });
      return projectMembersService.addMember({
        key: s.projectKey,
        actorUserId: ctx.userId,
        ctx,
        targetUserId: target.id,
        role: 'member',
      });
    },
  },
  {
    domain: 'access level',
    key: 'project:manage_access',
    write: (s, ctx) =>
      projectMembersService.setAccessLevel({
        key: s.projectKey,
        actorUserId: ctx.userId,
        ctx,
        level: 'private',
      }),
  },
  {
    domain: 'board',
    key: 'board:configure',
    write: (s, ctx) =>
      boardsService.addColumn(s.boardId, { name: `Col ${ctx.userId.slice(-5)}` }, ctx),
  },
  {
    domain: 'workflow',
    key: 'workflow:manage',
    write: (s, ctx) =>
      workflowsService.createStatus({
        userId: ctx.userId,
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        key: `st_${ctx.userId.slice(-6).toLowerCase()}`,
        label: `St ${ctx.userId.slice(-5)}`,
        category: 'todo',
      }),
  },
  {
    domain: 'component',
    key: 'component:manage',
    write: (s, ctx) =>
      componentsService.createComponent(
        { key: s.projectKey, name: `Cmp ${ctx.userId.slice(-5)}` },
        ctx,
      ),
  },
  {
    domain: 'field',
    key: 'field:manage',
    write: (s, ctx) =>
      customFieldsService.createField({
        key: s.projectKey,
        actorUserId: ctx.userId,
        ctx,
        label: `Fld ${ctx.userId.slice(-5)}`,
        fieldType: 'text',
      }),
  },
  {
    domain: 'estimation',
    key: 'estimation:manage',
    write: (s, ctx) =>
      estimationService.updateEstimationConfig(s.projectId, { pointScale: 'linear' }, ctx),
  },
  {
    domain: 'repository',
    key: 'repository:manage',
    write: (s, ctx) =>
      projectRepoSetService.addRow(
        s.projectId,
        { role: 'web', name: `r-${ctx.userId.slice(-5)}` },
        ctx,
      ),
  },
  {
    domain: 'AI settings',
    key: 'ai:configure',
    write: (s, ctx) =>
      projectAiSettingsService.updateAiSettings(s.projectKey, { aiAutoPlanEnabled: true }, ctx),
  },
];

describe.each(DOMAIN_WRITES)('the $domain domain, end to end', ({ domain, key, write }) => {
  it(`a project ADMIN passes — ${key}`, async () => {
    const s = await scenario(`ok-${domain.replace(/\W/g, '')}`);
    await expect(write(s, s.adminCtx)).resolves.toBeDefined();
  });

  it(`a project MEMBER is refused 403 naming ${key}`, async () => {
    const s = await scenario(`deny-${domain.replace(/\W/g, '')}`);
    const err = await write(s, s.memberCtx).catch((e: unknown) => e);
    expect(err, `${domain}: a project member must not pass`).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permission).toBe(key);
  });

  it('a NON-BROWSER gets 404, never 403 — the project stays hidden', async () => {
    const s = await scenario(`hide-${domain.replace(/\W/g, '')}`);
    await expect(write(s, s.outsiderCtx)).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('a WORKSPACE OWNER passes on every access level — the always-pass rail', async () => {
    for (const level of ['open', 'limited', 'private'] as const) {
      const s = await scenario(`rail-${domain.replace(/\W/g, '')}-${level}`);
      await db.project.update({ where: { id: s.projectId }, data: { accessLevel: level } });
      await expect(write(s, s.ownerCtx), `${domain} on a ${level} project`).resolves.toBeDefined();
    }
  });
});

describe('the split did not OVER-tighten — the reads a member needs still work', () => {
  // The direction a coverage number is blindest to. Every one of these is what an
  // ordinary member's create/edit form, board or settings pane reads; a `manage`
  // key on any of them breaks the product for everyone who is not an admin, and
  // every per-domain gate test would still be green.
  it('a project member can still read the vocabularies, the board and the settings', async () => {
    const s = await scenario('reads');
    const ctx = s.memberCtx;

    expect(
      (await componentsService.listComponents(s.projectKey, ctx)).length,
    ).toBeGreaterThanOrEqual(0);
    expect(
      (await customFieldsService.listFields({ key: s.projectKey, actorUserId: ctx.userId, ctx }))
        .length,
    ).toBeGreaterThanOrEqual(0);
    expect((await estimationService.getEstimationConfig(s.projectId, ctx)).pointScale).toBeTruthy();
    expect((await boardsService.getBoard(s.projectId, ctx)).columns.length).toBeGreaterThan(0);
    expect((await boardsService.listBoards(s.projectId, ctx)).length).toBeGreaterThan(0);
    expect(
      (await projectMembersService.listMembers({ key: s.projectKey, actorUserId: ctx.userId, ctx }))
        .length,
    ).toBeGreaterThan(0);
    expect(
      (await projectMembersService.getAccess({ key: s.projectKey, actorUserId: ctx.userId, ctx }))
        .accessLevel,
    ).toBe('private');
    expect(
      (await projectAiSettingsService.getAiSettings(s.projectKey, ctx)).aiAutoPlanEnabled,
    ).toBe(false);
    expect((await projectRepoSetService.getSet(s.projectId, ctx)).rows).toEqual([]);
  });

  it('a project member keeps the capabilities the split never claimed', async () => {
    const s = await scenario('keeps');
    const held = await projectAccessService.getPermissions(s.projectId, s.memberCtx);
    // Untouched by MOTIR-2256 — dragging a card, commenting, attaching.
    expect(held.has('work_item:edit')).toBe(true);
    expect(held.has('comment:add')).toBe(true);
    expect(held.has('attachment:create')).toBe(true);
    // …and none of the twelve.
    for (const { key } of DOMAIN_WRITES) {
      expect(held.has(key), `a project member must not hold ${key}`).toBe(false);
    }
  });
});
