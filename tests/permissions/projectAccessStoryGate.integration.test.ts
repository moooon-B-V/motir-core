import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectAccessMode } from '@/generated/prisma/client';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { adminDb } from '../helpers/adminDb';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// THE STORY GATE for MOTIR-6169 (Subtask MOTIR-6552) — ACCESS on the project: the
// three modes, the Full / Limited scope, and "was added". Run against the merged
// cards, it does what no card's own units can: every card mocks the OTHER side
// of the seam it touches, and this file mocks nothing but the session doors.
//
//   * THE ENTRY MATRIX — 3 modes × 6 actors × 5 surfaces, every cell WRITTEN OUT:
//     the resolver (`getPermissions`), the listing (`listProjects`), search
//     (`quickSearch`), MCP (`list_projects`) and a project-scoped route (`GET
//     /api/projects/[key]/components`, 200 or 404 — never a 403 that would confirm the
//     project exists). The actors include the ones the query is NOT about (the
//     expected-table limb): a Limited member and a stranger sit beside the people
//     who can enter, so a read that forgot the scope, or the mode, shows up as a
//     wrong cell rather than as a green run.
//   * THE SEAMS between cards — a scope change, a mode change and an accepted
//     Limited invite each move the listing, the notifications, the unread count
//     and the active project TOGETHER.
//
// The migration's half is `tests/migrations/projectAccessMapping.test.ts`; the
// architecture guards are `tests/permissions/projectAccessArchitecture.test.ts`.

const ctxRef = { current: null as WorkspaceContext | null };
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
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

// A project-scoped read behind the plain browse gate, answered not-found on a refusal.
const projectRoute = await import('@/app/api/projects/[key]/components/route');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { projectMembersService } = await import('@/lib/services/projectMembersService');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { runListProjects } = await import('@/lib/mcp/tools/listProjects');
const { PUBLIC_PROJECT_PERMISSIONS, ROLE_GATED_PERMISSIONS, WORKSPACE_ROLE_PERMISSIONS } =
  await import('@/lib/permissions/builtinRoles');
const { truncateAuthTables } = await import('../helpers/db');

beforeEach(async () => {
  ctxRef.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
const user = (label: string) =>
  usersService.createUser({
    email: `pag-${label}-${seq++}@ex.com`,
    password: 'hunter2hunter2',
    name: label,
  });

type Actor = 'manager' | 'orgAdmin' | 'added' | 'full' | 'limited' | 'none';
const ACTORS: Actor[] = ['manager', 'orgAdmin', 'added', 'full', 'limited', 'none'];

interface Tenant {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  needle: string;
  ctx: Record<Actor, WorkspaceContext>;
  managerCtx: WorkspaceContext;
}

/**
 * One workspace, one project in `mode`, one work item whose title is a needle
 * for search, and the six actors: the stored Manager, an org Admin who never
 * joined, a Full member ADDED to the project, a Full member not added, a Limited
 * member not added, and a user with no membership here at all.
 */
async function tenant(mode: ProjectAccessMode): Promise<Tenant> {
  const manager = await user('manager');
  const { workspace } = await workspacesService.createWorkspace({
    name: `PAG ${seq++}`,
    ownerUserId: manager.id,
  });
  const managerCtx = { userId: manager.id, workspaceId: workspace.id };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: manager.id,
    name: `Gate ${mode}`,
  });
  const needle = `gateneedle${mode}${seq++}`;
  await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: needle },
    managerCtx,
  );

  const orgAdmin = await user('orgadmin');
  await adminDb.organizationMembership.create({
    data: { organizationId: workspace.organizationId, userId: orgAdmin.id, role: 'admin' },
  });
  const member = async (label: string) => {
    const u = await user(label);
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    return u;
  };
  const added = await member('added');
  await projectMembersService.addMember({
    key: project.identifier,
    actorUserId: manager.id,
    ctx: managerCtx,
    targetUserId: added.id,
  });
  const full = await member('full');
  const limited = await member('limited');
  await workspacesService.setMemberAccessScope({
    actorUserId: manager.id,
    workspaceId: workspace.id,
    targetUserId: limited.id,
    scope: 'limited',
  });
  const none = await user('none');

  if (mode === 'public') {
    // Public is a cloud capability (MOTIR-4035); the column is written directly,
    // both columns together, as the setter writes them.
    await adminDb.project.update({
      where: { id: project.id },
      data: projectAccessData('public'),
    });
  } else if (mode === 'members') {
    await projectMembersService.setAccessMode({
      key: project.identifier,
      mode: 'members',
      actorUserId: manager.id,
      ctx: managerCtx,
    });
  }

  const at = (userId: string) => ({ userId, workspaceId: workspace.id });
  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    needle,
    managerCtx,
    ctx: {
      manager: managerCtx,
      orgAdmin: at(orgAdmin.id),
      added: at(added.id),
      full: at(full.id),
      limited: at(limited.id),
      none: at(none.id),
    },
  };
}

// ─── The expected key sets, named from the built-in constants — never from the
// resolver under test. ────────────────────────────────────────────────────────
type KeySet = 'nothing' | 'public' | 'manager' | 'member' | 'public+member';
const union = (...sets: Iterable<PermissionKey>[]) =>
  [...new Set(sets.flatMap((s) => [...s]))].sort();
const KEYS: Record<KeySet, PermissionKey[]> = {
  nothing: [],
  public: union(PUBLIC_PROJECT_PERMISSIONS),
  manager: union(ROLE_GATED_PERMISSIONS),
  member: union(WORKSPACE_ROLE_PERMISSIONS.member),
  'public+member': union(PUBLIC_PROJECT_PERMISSIONS, WORKSPACE_ROLE_PERMISSIONS.member),
};
// A Manager on a public project also holds the public request grants.
const managerOn = (mode: ProjectAccessMode): PermissionKey[] =>
  mode === 'public' ? union(ROLE_GATED_PERMISSIONS, PUBLIC_PROJECT_PERMISSIONS) : KEYS.manager;

interface Row {
  keys: KeySet | 'manager';
  listed: boolean;
  searched: boolean;
  mcp: boolean;
  route: 200 | 404;
}

/**
 * THE MATRIX, every cell written out. Read a row as "this actor, on a project in
 * this mode". `keys` names the expected permission set; the four booleans say
 * whether the project (or its item) appears; `route` is the project GET's status.
 *
 * The Public rows record one deliberate asymmetry: a Limited member and a
 * stranger hold Public's read set — `project:browse` among it, which is why the
 * project GET answers them 200 — but the project is NOT a place they are "in",
 * so the listing, search and MCP (which follow ENTRY, `canEnter`) leave it out.
 * The Visitor's reading surface is MOTIR-6170's.
 */
const MATRIX: Record<ProjectAccessMode, Record<Actor, Row>> = {
  workspace: {
    manager: { keys: 'manager', listed: true, searched: true, mcp: true, route: 200 },
    orgAdmin: { keys: 'manager', listed: true, searched: true, mcp: true, route: 200 },
    added: { keys: 'member', listed: true, searched: true, mcp: true, route: 200 },
    full: { keys: 'member', listed: true, searched: true, mcp: true, route: 200 },
    limited: { keys: 'nothing', listed: false, searched: false, mcp: false, route: 404 },
    none: { keys: 'nothing', listed: false, searched: false, mcp: false, route: 404 },
  },
  members: {
    manager: { keys: 'manager', listed: true, searched: true, mcp: true, route: 200 },
    orgAdmin: { keys: 'manager', listed: true, searched: true, mcp: true, route: 200 },
    added: { keys: 'member', listed: true, searched: true, mcp: true, route: 200 },
    full: { keys: 'nothing', listed: false, searched: false, mcp: false, route: 404 },
    limited: { keys: 'nothing', listed: false, searched: false, mcp: false, route: 404 },
    none: { keys: 'nothing', listed: false, searched: false, mcp: false, route: 404 },
  },
  public: {
    manager: { keys: 'manager', listed: true, searched: true, mcp: true, route: 200 },
    orgAdmin: { keys: 'manager', listed: true, searched: true, mcp: true, route: 200 },
    added: { keys: 'public+member', listed: true, searched: true, mcp: true, route: 200 },
    full: { keys: 'public+member', listed: true, searched: true, mcp: true, route: 200 },
    limited: { keys: 'public', listed: false, searched: false, mcp: false, route: 200 },
    none: { keys: 'public', listed: false, searched: false, mcp: false, route: 200 },
  },
};

/** A refusal (not-a-member, not-found) reads as "not there" — the only honest answer. */
async function orAbsent<T>(read: () => Promise<T>, test: (v: T) => boolean): Promise<boolean> {
  try {
    return test(await read());
  } catch {
    return false;
  }
}

async function measure(t: Tenant, actor: Actor): Promise<Row & { keysActual: PermissionKey[] }> {
  const ctx = t.ctx[actor];
  const keysActual = [...(await projectAccessService.getPermissions(t.projectId, ctx))].sort();
  const listed = await orAbsent(
    () => projectsService.listProjects(t.workspaceId, ctx.userId),
    (ps) => ps.some((p) => p.id === t.projectId),
  );
  const searched = await orAbsent(
    () => workItemsService.quickSearch(t.needle, ctx),
    (items) => items.some((i) => i.title === t.needle),
  );
  const mcp = await orAbsent(
    () => runListProjects(ctx),
    (r) =>
      !r.isError &&
      (r.structuredContent as { projects: { key: string }[] }).projects.some(
        (p) => p.key === t.projectKey,
      ),
  );
  ctxRef.current = ctx;
  const res = await projectRoute.GET(
    new Request(`http://x/api/projects/${t.projectKey}/components`),
    {
      params: Promise.resolve({ key: t.projectKey }),
    },
  );
  ctxRef.current = null;
  return {
    keys: 'nothing',
    keysActual,
    listed,
    searched,
    mcp,
    route: res.status as 200 | 404,
  };
}

describe('THE ENTRY MATRIX — 3 modes × 6 actors × 5 surfaces', () => {
  it.each<ProjectAccessMode>(['workspace', 'members', 'public'])(
    'a project in mode %s',
    async (mode) => {
      const t = await tenant(mode);
      const wrong: string[] = [];
      for (const actor of ACTORS) {
        const want = MATRIX[mode][actor];
        const got = await measure(t, actor);
        const wantKeys = want.keys === 'manager' ? managerOn(mode) : KEYS[want.keys];
        if (JSON.stringify(got.keysActual) !== JSON.stringify(wantKeys)) {
          wrong.push(`${mode}/${actor} keys: want ${want.keys}, got [${got.keysActual.join(',')}]`);
        }
        for (const surface of ['listed', 'searched', 'mcp', 'route'] as const) {
          if (got[surface] !== want[surface]) {
            wrong.push(`${mode}/${actor} ${surface}: want ${want[surface]}, got ${got[surface]}`);
          }
        }
        // Never a 403: a refusal must be indistinguishable from a missing project.
        expect(got.route).not.toBe(403);
      }
      expect(wrong).toEqual([]);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SEAMS — one change, four reads, in step
// ═══════════════════════════════════════════════════════════════════════════

const { notificationsService } = await import('@/lib/services/notificationsService');
const { workspaceInvitesService, INVITE_IDENTIFIER_PREFIX } =
  await import('@/lib/services/workspaceInvitesService');

let noteSeq = 0;
/** One unread notification about a work item, for `recipientUserId`. */
async function notify(workspaceId: string, recipientUserId: string, workItemId: string) {
  return adminDb.notification.create({
    data: {
      workspaceId,
      recipientUserId,
      type: 'work_item.assigned',
      category: 'direct',
      workItemId,
      data: {},
      dedupeKey: `pag-${noteSeq++}`,
    },
  });
}

/** What one reader sees of project P across the four reads the seam must move together. */
async function view(t: { workspaceId: string; projectId: string }, ctx: WorkspaceContext) {
  const [listed, page, unread, active] = await Promise.all([
    projectsService.listProjects(t.workspaceId, ctx.userId),
    notificationsService.listNotifications({}, ctx),
    notificationsService.getUnreadCount(ctx),
    projectsService.getActiveProject(ctx.userId, t.workspaceId),
  ]);
  return {
    listed: listed.some((p) => p.id === t.projectId),
    notified: page.notifications.length,
    unread: unread.unreadCount,
    active: active?.id ?? null,
  };
}

/** A workspace with ONE project P (in `mode`), an item in it, and a Full member pinned to it. */
async function seamTenant() {
  const manager = await user('smanager');
  const { workspace } = await workspacesService.createWorkspace({
    name: `SEAM ${seq++}`,
    ownerUserId: manager.id,
  });
  const managerCtx = { userId: manager.id, workspaceId: workspace.id };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: manager.id,
    name: 'Seam',
  });
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'seam item' },
    managerCtx,
  );
  const reader = await user('reader');
  await workspacesService.addMember({ userId: reader.id, workspaceId: workspace.id });
  const readerCtx = { userId: reader.id, workspaceId: workspace.id };
  await projectsService.setActiveProject({ ...readerCtx, projectId: project.id });
  await notify(workspace.id, reader.id, item.id);
  return {
    manager,
    managerCtx,
    workspaceId: workspace.id,
    project,
    projectId: project.id,
    reader,
    readerCtx,
  };
}

describe('THE SEAMS — a change moves every read at once', () => {
  it('Limited: the same person’s listing, notifications, unread count and active project all shrink together', async () => {
    const s = await seamTenant();
    expect(await view(s, s.readerCtx)).toEqual({
      listed: true,
      notified: 1,
      unread: 1,
      active: s.projectId,
    });

    await workspacesService.setMemberAccessScope({
      actorUserId: s.manager.id,
      workspaceId: s.workspaceId,
      targetUserId: s.reader.id,
      scope: 'limited',
    });

    expect(await view(s, s.readerCtx)).toEqual({
      listed: false,
      notified: 0,
      unread: 0,
      active: null,
    });
  });

  it('Members only: a Full member who was not added loses the project from all four at once', async () => {
    const s = await seamTenant();
    await projectMembersService.setAccessMode({
      key: s.project.identifier,
      mode: 'members',
      actorUserId: s.manager.id,
      ctx: s.managerCtx,
    });
    expect(await view(s, s.readerCtx)).toEqual({
      listed: false,
      notified: 0,
      unread: 0,
      active: null,
    });
    // …and adding them brings every one back, nothing having been deleted.
    await projectMembersService.addMember({
      key: s.project.identifier,
      actorUserId: s.manager.id,
      ctx: s.managerCtx,
      targetUserId: s.reader.id,
    });
    expect(await view(s, s.readerCtx)).toEqual({
      listed: true,
      notified: 1,
      unread: 1,
      active: s.projectId,
    });
  });

  it('a Limited invite into A, accepted: the person’s FIRST active project is A', async () => {
    const manager = await user('imanager');
    const { workspace } = await workspacesService.createWorkspace({
      name: `INV ${seq++}`,
      ownerUserId: manager.id,
    });
    const projects = [];
    for (const name of ['Beta first', 'Alpha']) {
      projects.push(
        await projectsService.createProject({
          workspaceId: workspace.id,
          actorUserId: manager.id,
          name,
        }),
      );
    }
    const target = projects[1]!;
    const contractor = await user('contractor');
    await workspaceInvitesService.sendInvite({
      inviterUserId: manager.id,
      inviterName: 'Manager',
      workspaceId: workspace.id,
      targetEmail: contractor.email,
      accessScope: 'limited',
      projectIds: [target.id],
    });
    const row = await adminDb.verification.findFirstOrThrow({
      where: {
        identifier: { startsWith: INVITE_IDENTIFIER_PREFIX },
        value: { contains: contractor.email },
      },
    });
    await workspaceInvitesService.acceptInvite(
      row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length),
      { id: contractor.id, email: contractor.email },
    );

    const active = await projectsService.getActiveProject(contractor.id, workspace.id);
    expect(active?.id).toBe(target.id);
    const listed = await projectsService.listProjects(workspace.id, contractor.id);
    expect(listed.map((p) => p.id)).toEqual([target.id]);
  });
});
