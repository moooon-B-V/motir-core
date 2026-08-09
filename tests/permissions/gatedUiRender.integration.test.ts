import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  groupSettingsNav,
  hasVisibleSettingsArea,
  toSettingsNavPermissions,
  visibleSettingsNav,
} from '@/lib/settings/projectSettingsNav';
import { PROJECT_NAV_ACCESS, canOfferNavDestination } from '@/lib/settings/projectNavAccess';
import { resolveSettingsRefusal } from '@/app/(authed)/settings/project/_guard';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-2258 · Subtask MOTIR-2476 — RESOLUTION TO RENDER, end to end.
//
// The unit suites each mock one end: the registry tests hand the filters a set
// somebody typed, and the service tests stop at the set. This drives the whole
// path — a seeded membership row, through the real `getPermissionsDTO`, into the
// shell's actual filters — so a divergence anywhere along it fails here.
//
// Real Postgres, real services, no mocked policy. It is DB-backed and therefore
// runs in the Vitest integration job, not in the fast unit lane.

const PASSWORD = 'gated-ui-render-pass-123';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

const ctxFor = (userId: string, workspaceId: string): WorkspaceContext => ({ userId, workspaceId });

interface Seeded {
  projectId: string;
  workspaceId: string;
  ctxs: Record<'admin' | 'member' | 'viewer', WorkspaceContext>;
}

/** A workspace + open project with one actor at each built-in project role. */
async function seed(slug: string): Promise<Seeded> {
  const owner = await usersService.createUser({
    email: `owner-${slug}@ex.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ownerCtx = ctxFor(owner.id, workspace.id);

  async function actor(role: 'admin' | 'member' | 'viewer') {
    const user = await usersService.createUser({
      email: `${role}-${slug}@ex.com`,
      password: PASSWORD,
      name: role,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: user.id,
      role,
    });
    return ctxFor(user.id, workspace.id);
  }

  return {
    projectId: project.id,
    workspaceId: workspace.id,
    ctxs: {
      admin: await actor('admin'),
      member: await actor('member'),
      viewer: await actor('viewer'),
    },
  };
}

/** Everything the shell decides for an actor, from their REAL resolved DTO. */
async function renderFor(projectId: string, ctx: WorkspaceContext) {
  const dto = await projectAccessService.getPermissionsDTO(projectId, ctx);
  const held = toSettingsNavPermissions(dto.permissions);
  return {
    dto,
    held,
    settingsEntries: visibleSettingsNav(held).map((e) => e.id),
    settingsGroups: groupSettingsNav(visibleSettingsNav(held)).map((g) => g.group),
    areaDoor: hasVisibleSettingsArea(held),
    navRows: PROJECT_NAV_ACCESS.filter((e) => canOfferNavDestination(e.href, held)).map(
      (e) => e.href,
    ),
  };
}

describe('a seeded role renders exactly what it holds', () => {
  it('a project ADMIN is offered the whole shell', async () => {
    const s = await seed('admin-path');
    const shell = await renderFor(s.projectId, s.ctxs.admin);

    expect(shell.settingsEntries.length).toBe(12);
    expect(shell.settingsGroups).toEqual(['general', 'access', 'work', 'automation']);
    expect(shell.areaDoor).toBe(true);
    expect(shell.navRows).toEqual(PROJECT_NAV_ACCESS.map((e) => e.href));
  });

  it('a project MEMBER gets NO settings area, and keeps every nav row but Code health', async () => {
    const s = await seed('member-path');
    const shell = await renderFor(s.projectId, s.ctxs.member);

    // The complaint the story was raised about: nine sections a member could
    // change nothing in.
    expect(shell.settingsEntries).toEqual([]);
    expect(shell.settingsGroups).toEqual([]);
    expect(shell.areaDoor).toBe(false);

    expect(shell.navRows).not.toContain('/code-health');
    for (const href of ['/dashboard', '/items', '/boards', '/backlog', '/reports', '/triage']) {
      expect(shell.navRows, href).toContain(href);
    }
  });

  it('a project VIEWER loses the three destinations that refuse them outright', async () => {
    const s = await seed('viewer-path');
    const shell = await renderFor(s.projectId, s.ctxs.viewer);

    expect(shell.areaDoor).toBe(false);
    for (const gone of ['/plans', '/triage', '/code-health']) {
      expect(shell.navRows, gone).not.toContain(gone);
    }
    // …and keeps every read surface. The primary nav never renders empty for an
    // actor who reached this shell at all.
    expect(shell.navRows.length).toBeGreaterThan(5);
  });

  it('every settings entry an actor is OFFERED is one the guard would admit them to', async () => {
    // The agreement, driven from a real resolution rather than a typed set: what
    // the rail shows and what the destination admits cannot disagree.
    const s = await seed('agreement');
    for (const role of ['admin', 'member', 'viewer'] as const) {
      const shell = await renderFor(s.projectId, s.ctxs[role]);
      for (const entry of shell.settingsEntries) {
        expect(
          resolveSettingsRefusal(entry as never, shell.held),
          `${role} is offered "${entry}" and the guard refuses it`,
        ).toBeNull();
      }
    }
  });
});

describe('the cross-tenant arm — a foreign project resolves to nothing', () => {
  it('an actor from another workspace is offered no rail, no door and no rows', async () => {
    const mine = await seed('tenant-a');
    const theirs = await seed('tenant-b');

    // `resolveInputs` answers a foreign project as NOT FOUND before it reaches a
    // membership read — the shipped 404-before-403 posture, so the resolution
    // never even returns a set to render from. That IS the cross-tenant
    // guarantee at this layer: there is no path from a foreign id to a surface.
    await expect(
      projectAccessService.getPermissionsDTO(theirs.projectId, mine.ctxs.admin),
    ).rejects.toThrow(ProjectNotFoundError);
  });
});
