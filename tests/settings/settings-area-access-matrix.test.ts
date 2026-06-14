import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  PROJECT_SETTINGS_NAV,
  visibleSettingsNav,
  type SettingsNavCapabilities,
} from '@/lib/settings/projectSettingsNav';
import type { ProjectAccessLevel } from '@prisma/client';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// Story 6.5 · Subtask 6.5.4 — the settings-area role-gating matrix proven over
// the REAL stack (Postgres + the shipped services), the DB-backed half of the
// story-closing verification. The 6.5.2 unit suite
// (`tests/settings/projectSettingsNav.test.ts`) pins the registry's pure
// predicates in isolation; this suite proves the chain the area actually runs:
//
//     seeded 6.4 role  →  projectAccessService.getSettingsCapabilities  →
//     the registry's per-entry `access` predicate  →  the visible nav + the
//     page-level gate
//
// agree end-to-end with the 6.4.3 policy, for every (access level × role). It is
// DRIVEN from the registry — it asserts each `PROJECT_SETTINGS_NAV` entry's
// visibility equals its own predicate applied to the actor's REAL capabilities,
// so a new entry (or a new predicate, e.g. a `canManage`-gated Story-6.6 row)
// is covered the moment it lands; and it pins the two area invariants the
// design names — NO nav leak (a non-browser sees nothing) and NO orphan page (a
// visible nav ⟺ a browsable project).

const PASSWORD = 'settings-area-matrix-pass-123';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  // Release the worktree-side pool so it doesn't keep the runner alive past the
  // last test (mirrors project-access-service / project-isolation).
  await db.$disconnect();
});

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

function ctxFor(userId: string, workspaceId: string): WorkspaceContext {
  return { userId, workspaceId };
}

type Role = 'owner' | 'wsAdmin' | 'plainMember' | 'viewer' | 'member' | 'admin' | 'nonMember';

interface Scenario {
  projectId: string;
  ctxs: Record<Role, WorkspaceContext>;
}

/**
 * Build a workspace + project at `level`, then attach one actor per role. The
 * access level is set FIRST (going `private` auto-seeds the THEN-current members
 * as project members — only the owner exists at that point), so the
 * workspace-admin + plain-member carry NO project membership and each role is
 * set up cleanly. Mirrors `project-access-service.test.ts`'s `buildScenario`.
 */
async function buildScenario(level: ProjectAccessLevel, slug: string): Promise<Scenario> {
  const owner = await makeUser(`owner-${slug}@ex.com`, 'Owner');
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

  // `public` is not yet settable through the service setter (the make-public
  // toggle is Subtask 6.12.8; `asAccessLevel` still rejects it), so seed it
  // directly at the data layer; the 3 settable levels go through the real setter.
  if (level === 'public') {
    await db.project.update({ where: { id: project.id }, data: { accessLevel: 'public' } });
  } else {
    await projectMembersService.setAccessLevel({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level,
    });
  }

  const wsAdmin = await makeUser(`wsadmin-${slug}@ex.com`, 'WsAdmin');
  await workspacesService.addMember({
    userId: wsAdmin.id,
    workspaceId: workspace.id,
    role: 'admin',
  });

  const plainMember = await makeUser(`plain-${slug}@ex.com`, 'Plain');
  await workspacesService.addMember({ userId: plainMember.id, workspaceId: workspace.id });

  async function projectActor(role: 'viewer' | 'member' | 'admin') {
    const u = await makeUser(`${role}-${slug}@ex.com`, role);
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: u.id,
      role,
    });
    return u;
  }
  const viewer = await projectActor('viewer');
  const member = await projectActor('member');
  const admin = await projectActor('admin');

  // A workspace member with NO project role — the genuine non-member on a
  // private project (a non-WORKSPACE user can't even resolve a context).
  const nonMember = await makeUser(`outsider-${slug}@ex.com`, 'Outsider');
  await workspacesService.addMember({ userId: nonMember.id, workspaceId: workspace.id });

  return {
    projectId: project.id,
    ctxs: {
      owner: ownerCtx,
      wsAdmin: ctxFor(wsAdmin.id, workspace.id),
      plainMember: ctxFor(plainMember.id, workspace.id),
      viewer: ctxFor(viewer.id, workspace.id),
      member: ctxFor(member.id, workspace.id),
      admin: ctxFor(admin.id, workspace.id),
      nonMember: ctxFor(nonMember.id, workspace.id),
    },
  };
}

// The expected (browse, manage) verdict per role for each access level — the
// 6.4.3 policy the settings area rides. `browse` decides whether ANY settings
// entry/page is reachable (no nav leak); `manage` decides the admin-only
// surfaces (the Details danger zone today, the Story-6.6 Automation row next).
const EXPECTED: Record<ProjectAccessLevel, Record<Role, { browse: boolean; manage: boolean }>> = {
  open: {
    owner: { browse: true, manage: true },
    wsAdmin: { browse: true, manage: true },
    plainMember: { browse: true, manage: false },
    viewer: { browse: true, manage: false },
    member: { browse: true, manage: false },
    admin: { browse: true, manage: true },
    nonMember: { browse: true, manage: false },
  },
  limited: {
    owner: { browse: true, manage: true },
    wsAdmin: { browse: true, manage: true },
    plainMember: { browse: true, manage: false },
    viewer: { browse: true, manage: false },
    member: { browse: true, manage: false },
    admin: { browse: true, manage: true },
    nonMember: { browse: true, manage: false },
  },
  private: {
    owner: { browse: true, manage: true },
    wsAdmin: { browse: true, manage: true },
    plainMember: { browse: false, manage: false },
    viewer: { browse: true, manage: false },
    member: { browse: true, manage: false },
    admin: { browse: true, manage: true },
    nonMember: { browse: false, manage: false },
  },
  // `public` (Story 6.12) — browse is true for EVERYONE (the cross-org read
  // exception); `manage` is unchanged (workspace owner/admin or project admin),
  // so the settings-area row mirrors `open`. These actors all resolve through
  // the workspace-scoped getSettingsCapabilities; the anonymous public-READ path
  // is the public-VIEW surface's concern (6.12.4 / 6.12.9) — settings stays
  // member-facing.
  public: {
    owner: { browse: true, manage: true },
    wsAdmin: { browse: true, manage: true },
    plainMember: { browse: true, manage: false },
    viewer: { browse: true, manage: false },
    member: { browse: true, manage: false },
    admin: { browse: true, manage: true },
    nonMember: { browse: true, manage: false },
  },
};

const LEVELS: ProjectAccessLevel[] = ['open', 'limited', 'private', 'public'];
const ROLES: Role[] = ['owner', 'wsAdmin', 'plainMember', 'viewer', 'member', 'admin', 'nonMember'];

describe('settings-area role-gating matrix — capabilities ride the 6.4.3 policy', () => {
  for (const level of LEVELS) {
    describe(`access level: ${level}`, () => {
      let scenario: Scenario;

      beforeEach(async () => {
        scenario = await buildScenario(level, `${level}`);
      });

      for (const role of ROLES) {
        it(`${role} — capabilities match the policy`, async () => {
          const caps = await projectAccessService.getSettingsCapabilities(
            scenario.projectId,
            scenario.ctxs[role],
          );
          const expected = EXPECTED[level][role];
          expect(caps.canBrowse).toBe(expected.browse);
          expect(caps.canManage).toBe(expected.manage);
        });
      }
    });
  }
});

describe('settings-area role-gating matrix — nav visibility (driven from the registry)', () => {
  for (const level of LEVELS) {
    describe(`access level: ${level}`, () => {
      let scenario: Scenario;

      beforeEach(async () => {
        scenario = await buildScenario(level, `nav-${level}`);
      });

      for (const role of ROLES) {
        it(`${role} — every registry entry's visibility equals its predicate on the real caps`, async () => {
          const caps = await projectAccessService.getSettingsCapabilities(
            scenario.projectId,
            scenario.ctxs[role],
          );
          const navCaps: SettingsNavCapabilities = {
            canBrowse: caps.canBrowse,
            canManage: caps.canManage,
          };
          const visible = visibleSettingsNav(navCaps);
          const visibleIds = new Set(visible.map((e) => e.id));

          // Drift-proof: assert PER entry that visibility === the entry's own
          // predicate applied to the actor's real, seeded capabilities. A new
          // entry — or one with a new predicate (a `canManage` Story-6.6 row) —
          // is covered automatically, with no matrix edit.
          for (const entry of PROJECT_SETTINGS_NAV) {
            expect(visibleIds.has(entry.id)).toBe(entry.access(navCaps));
          }
        });

        it(`${role} — no nav leak / no orphan page (visible nav ⟺ browsable)`, async () => {
          const caps = await projectAccessService.getSettingsCapabilities(
            scenario.projectId,
            scenario.ctxs[role],
          );
          const visible = visibleSettingsNav({
            canBrowse: caps.canBrowse,
            canManage: caps.canManage,
          });
          // The whole area gates on browse: a non-browser sees NOTHING (no nav
          // leak). A browser sees every entry whose own access predicate it
          // satisfies — the full nav for an admin, but minus the ADMIN-ONLY
          // entries for a browse-only member/viewer. Story 6.6's Automation
          // entry is the first admin-gated one (`access: manage`), so pin the
          // split explicitly: an admin sees all; a non-admin browser sees all
          // EXCEPT Automation — neither a leak nor an orphan can slip past.
          if (!caps.canBrowse) {
            expect(visible).toEqual([]);
          } else if (caps.canManage) {
            expect(visible).toEqual(PROJECT_SETTINGS_NAV);
          } else {
            expect(visible).toEqual(
              PROJECT_SETTINGS_NAV.filter((entry) => entry.id !== 'automation'),
            );
          }
        });
      }
    });
  }
});

describe('settings-area role-gating matrix — page-level resolution', () => {
  it('an in-workspace non-member on a private project resolves (no-browse caps), NOT a 404', async () => {
    // The "made private while still pinned" path: the page must render the
    // 6.4.4 no-access STATE (a resolvable context with canBrowse=false), never
    // throw — the area layout shows NoAccessState, not a crash.
    const scenario = await buildScenario('private', 'page-private');
    const caps = await projectAccessService.getSettingsCapabilities(
      scenario.projectId,
      scenario.ctxs.nonMember,
    );
    expect(caps.canBrowse).toBe(false);
    expect(caps.canManage).toBe(false);
  });

  it('a cross-tenant / nonexistent project throws ProjectNotFoundError (the 404 gate, no existence leak)', async () => {
    const scenario = await buildScenario('open', 'page-foreign');
    await expect(
      projectAccessService.getSettingsCapabilities('prj_does_not_exist', scenario.ctxs.owner),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
