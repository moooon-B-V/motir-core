import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { Globe, Megaphone } from 'lucide-react';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_SETTINGS_NAV,
  PROJECT_SETTINGS_ROOT,
  PROJECT_SETTINGS_ROUTES,
  PROJECT_SETTINGS_ROUTE_PATHS,
  SETTINGS_NAV_GROUP_ORDER,
  groupSettingsNav,
  hasVisibleSettingsArea,
  isProjectSettingsPath,
  isSettingsEntryActive,
  settingsEntryViewKey,
  toSettingsNavPermissions,
  visibleSettingsNav,
  type SettingsNavEntry,
} from '@/lib/settings/projectSettingsNav';
import { resolveSettingsRefusal, settingsEntryKeys } from '@/app/(authed)/settings/project/_guard';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { PERMISSIONS, isPermissionKey, type PermissionKey } from '@/lib/permissions/catalog';

// Subtask 6.5.2 — the settings-nav registry is the single source for the area
// nav, the command-palette deep links, AND this totality guard. The suite fails
// the moment the registry and the filesystem routes drift apart (mistake #29),
// and pins the access-matrix + grouping contract the rail/palette rely on.

const SETTINGS_DIR = join(process.cwd(), 'app/(authed)/settings/project');

/** Enumerate the on-disk `settings/project/**​/page.tsx` routes → their URL paths. */
function collectFsRoutes(dir: string, base: string): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Next App Router ignores `_`-prefixed folders (private — e.g. _components).
      if (entry.name.startsWith('_')) continue;
      routes.push(...collectFsRoutes(join(dir, entry.name), `${base}/${entry.name}`));
    } else if (entry.name === 'page.tsx') {
      routes.push(base);
    }
  }
  return routes;
}

// MOTIR-2468 — the registry now filters on the actor's resolved PERMISSION SET,
// not on two booleans. The built-in role sets come from `builtinRoles.ts` so a
// change to what a role holds shows up here rather than in a hand-copied list.
const ADMIN = BUILTIN_ROLE_PERMISSIONS.admin;
const MEMBER = BUILTIN_ROLE_PERMISSIONS.member;
const VIEWER = BUILTIN_ROLE_PERMISSIONS.viewer;
const NO_ACCESS = toSettingsNavPermissions([]);

// The registry's SECOND axis (MOTIR-4243) — what the BUILD has, beside what the
// actor holds. It defaults CLOSED, so every assertion below that expects the
// whole rail has to say which deployment it is talking about; that is the point
// of the default rather than a cost of it.
const ON_CLOUD = { publicProjectsAvailable: true };
const SELF_HOSTED = { publicProjectsAvailable: false };
/** The entries that exist on EVERY build — the rail minus the cloud-only rooms. */
const ALWAYS_PRESENT = PROJECT_SETTINGS_NAV.filter((e) => !e.cloudOnly);

describe('projectSettingsNav registry — totality (route ↔ entry, mistake #29)', () => {
  it('every settings route is accounted for EXACTLY once, and vice versa', () => {
    const fsRoutes = collectFsRoutes(SETTINGS_DIR, PROJECT_SETTINGS_ROOT).sort();
    const registryRoutes = [...PROJECT_SETTINGS_ROUTE_PATHS].sort();

    // No drift in either direction: a new page nothing accounts for, or an
    // accounted-for route with no page, both fail.
    expect(registryRoutes).toEqual(fsRoutes);
    expect(new Set(registryRoutes).size).toBe(registryRoutes.length);
  });

  // MOTIR-2263 added the area's first DRILL-DOWN — a second `page.tsx` under
  // `roles/` whose door is its parent's rail row rather than a row of its own.
  // The totality assertion above was widened to `PROJECT_SETTINGS_ROUTE_PATHS`
  // rather than weakened, and these three keep that widening honest: a nested
  // route must belong to its parent, must not become a rail row, and must still
  // light one.
  it('a declared nested route is a STRICT sub-path of the entry that owns it', () => {
    for (const entry of PROJECT_SETTINGS_ROUTES) {
      for (const nested of entry.nestedRoutes ?? []) {
        expect(nested.startsWith(`${entry.href}/`), `${nested} is not under ${entry.href}`).toBe(
          true,
        );
        expect(nested).not.toBe(entry.href);
      }
    }
  });

  it('a nested route never becomes a rail row or a palette action of its own', () => {
    const nested = PROJECT_SETTINGS_ROUTES.flatMap((e) => e.nestedRoutes ?? []);
    expect(nested.length, 'the drill-down this guard was widened for').toBeGreaterThan(0);
    for (const route of nested) {
      expect(PROJECT_SETTINGS_NAV.some((e) => e.href === route)).toBe(false);
    }
  });

  it('a nested route still lights its parent row — no destination without a door', () => {
    for (const entry of PROJECT_SETTINGS_ROUTES) {
      for (const nested of entry.nestedRoutes ?? []) {
        // The literal segment stands in for a real id; the rail matches by prefix.
        const concrete = nested.replace(/\[[^\]]+\]/g, 'admin');
        expect(isSettingsEntryActive(entry, concrete), `${entry.id} inactive on ${concrete}`).toBe(
          true,
        );
      }
    }
  });

  it('Roles & permissions is a member-domain Access entry with the detail as its drill-down', () => {
    const roles = PROJECT_SETTINGS_NAV.find((e) => e.id === 'roles');
    expect(roles?.href).toBe('/settings/project/roles');
    expect(roles?.group).toBe('access');
    expect(roles?.labelKey).toBe('nav.roles');
    // A real route, which since MOTIR-4324 retired the reserved-slot flag is
    // asserted as membership of the destination set rather than as the absence
    // of that flag.
    expect(PROJECT_SETTINGS_ROUTES).toContainEqual(roles);
    // MOTIR-2468 retired the browse gate this entry shipped with, and MOTIR-2257
    // moved the key it left to `project:manage_access`: that entry's own
    // reasoning turned on the screen having "no write of its own", and this story
    // gave it three — each gated by that key at the service.
    expect(roles?.permission).toBe('project:manage_access');
    expect(visibleSettingsNav(MEMBER).map((e) => e.id)).not.toContain('roles');
    expect(visibleSettingsNav(ADMIN).map((e) => e.id)).toContain('roles');
    // MOTIR-2483 added the two AUTHORING routes. Pinned literally, in order,
    // because this list is what keeps the rail row active on a drilled-in
    // screen — a route missing from it looks like a working page whose nav
    // silently deselects, which is exactly what the totality guard is for.
    expect(roles?.nestedRoutes).toEqual([
      '/settings/project/roles/[roleKey]',
      '/settings/project/roles/[roleKey]/edit',
      '/settings/project/roles/new',
    ]);
    // Rail order within Access — the model sits between who is on the team and
    // who can clone the code (design/projects/design-notes.md, access path).
    const accessIds = groupSettingsNav(PROJECT_SETTINGS_NAV)
      .find((g) => g.group === 'access')!
      .entries.map((e) => e.id);
    // MOTIR-4243 seats **Public page** directly under Members & access — the
    // room that owns the public concerns and the row a reader arrives from.
    //
    // MOTIR-4221 seats **Public address** directly under THAT, which is the
    // order `design/projects/design-notes.md` § *Public address* draws and NOT
    // the one its own card asked for: the card says "between Members & access
    // and Roles", and that slot was taken by Public page while the story was in
    // flight. Two public rooms either side of one door is the coherent shape,
    // and the asset reading beats the card text.
    expect(accessIds).toEqual(['members', 'public-page', 'public-address', 'roles', 'code-access']);
  });

  it('has no duplicate hrefs and no duplicate ids', () => {
    const hrefs = PROJECT_SETTINGS_ROUTES.map((e) => e.href);
    const ids = PROJECT_SETTINGS_NAV.map((e) => e.id);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the Automation slot is now a real admin-only route (Story 6.6 lit it up)', () => {
    const automation = PROJECT_SETTINGS_NAV.find((e) => e.id === 'automation');
    expect(automation?.permission).toBe('automation:manage');
    expect(automation?.href).toBe('/settings/project/automation');
    // It joins the route set (the totality test pairs it with the on-disk
    // automation/page.tsx). This membership USED to be the other half of an
    // `expect(automation?.placeholder).toBeUndefined()` above; MOTIR-4324 retired
    // that flag — this slot was the last one it was written for — so the
    // membership is now the whole assertion.
    expect(PROJECT_SETTINGS_ROUTES).toContainEqual(expect.objectContaining({ id: 'automation' }));
  });

  it('AI planning is a real browse-gated route ABOVE Rules in Automation (MOTIR-919)', () => {
    const aiPlanning = PROJECT_SETTINGS_NAV.find((e) => e.id === 'ai-planning');
    expect(aiPlanning?.href).toBe('/settings/project/ai-planning');
    expect(aiPlanning?.labelKey).toBe('nav.aiPlanning');
    // A real route — membership of the destination set, since MOTIR-4324 retired
    // the reserved-slot flag this used to assert the absence of.
    expect(PROJECT_SETTINGS_ROUTES).toContainEqual(aiPlanning);
    // MOTIR-2468: `ai:configure`, read off `projectAiSettingsService`. NOT
    // `ai:plan` — a member holds that and it gates RUNNING the planner, not
    // configuring it, which is exactly the name-similarity trap the card warns
    // against.
    expect(aiPlanning?.permission).toBe('ai:configure');
    expect(visibleSettingsNav(MEMBER).map((e) => e.id)).not.toContain('ai-planning');
    // Rail order within Automation — cadence sits above the rules editor.
    const automationIds = groupSettingsNav(PROJECT_SETTINGS_NAV)
      .find((g) => g.group === 'automation')!
      .entries.map((e) => e.id);
    expect(automationIds).toEqual(['ai-planning', 'automation']);
  });
});

describe('projectSettingsNav registry — access matrix (rides the 6.4.3 policy)', () => {
  it('a project admin sees every entry (incl. the admin-only Automation route)', () => {
    expect(visibleSettingsNav(ADMIN, PROJECT_SETTINGS_NAV, ON_CLOUD)).toEqual(PROJECT_SETTINGS_NAV);
    expect(visibleSettingsNav(ADMIN, PROJECT_SETTINGS_ROUTES, ON_CLOUD)).toEqual(
      PROJECT_SETTINGS_ROUTES,
    );
  });

  it('a project admin on a SELF-HOSTED build sees the rail MINUS the cloud-only rooms', () => {
    // The same actor, the same keys, a different build (MOTIR-4243 · MOTIR-3908).
    // Asserted as an EQUALITY against the derived set rather than as "does not
    // contain public-page": a second cloud-only room added later is covered here
    // the moment it lands, with no edit.
    expect(visibleSettingsNav(ADMIN, PROJECT_SETTINGS_NAV, SELF_HOSTED)).toEqual(ALWAYS_PRESENT);
    expect(ALWAYS_PRESENT.length).toBeLessThan(PROJECT_SETTINGS_NAV.length);
  });

  // ⚠️ THIS ASSERTION WAS INVERTED BY MOTIR-2468, DELIBERATELY. It read "a member
  // sees every section EXCEPT Automation", which was the 2026-06-09 directive's
  // read-only-for-a-non-admin model. That directive is SUPERSEDED — see
  // `design/projects/design-notes.md` § *Amendment 2026-08-08*, which hides an
  // entry point whose destination the actor cannot use at all. Eleven of twelve
  // entries flipped; the twelfth (Automation) was already right.
  //
  // ⚠️ AND INVERTED AGAIN BY MOTIR-5278, DELIBERATELY — `design/projects/design-notes.md`
  // § ⭐ Approvals §6, decided on MOTIR-5190. It read "a member sees NO section".
  // `approvals` now opens on `project:browse`, which every member holds, so a
  // member's rail is exactly that one room: one they may READ and not change,
  // because its gates decide whether their own finished work waits.
  it('a member sees exactly ONE section — Approvals, the room they may read and not change', () => {
    expect(visibleSettingsNav(MEMBER).map((e) => e.id)).toEqual(['approvals']);
    expect(visibleSettingsNav(MEMBER, PROJECT_SETTINGS_ROUTES).map((e) => e.id)).toEqual([
      'approvals',
    ]);
  });

  it('a no-browse actor sees NOTHING — the whole area filters away (no nav leak)', () => {
    expect(visibleSettingsNav(NO_ACCESS)).toEqual([]);
    expect(visibleSettingsNav(NO_ACCESS, PROJECT_SETTINGS_ROUTES)).toEqual([]);
  });
});

describe('the Public page room (Story MOTIR-3875 · MOTIR-4243)', () => {
  const entry = PROJECT_SETTINGS_NAV.find((e) => e.id === 'public-page');

  it('is registered per the design table, DIRECTLY under Members & access', () => {
    // `design/projects/design-notes.md` § *The entrance — three doors, and the
    // registry entry behind the first*, field by field.
    expect(entry).toBeTruthy();
    expect(entry!.group).toBe('access');
    expect(entry!.href).toBe('/settings/project/public');
    expect(entry!.labelKey).toBe('nav.publicPage');
    expect(entry!.permission).toBe('project:administer');
    expect(entry!.cloudOnly).toBe(true);
    expect(entry!.exact).toBeUndefined();

    const accessIds = groupSettingsNav(PROJECT_SETTINGS_NAV)
      .find((g) => g.group === 'access')!
      .entries.map((e) => e.id);
    expect(accessIds.indexOf('public-page')).toBe(accessIds.indexOf('members') + 1);
  });

  it('carries `Globe`, and NOT the Building-in-public status glyph', () => {
    // A room and a STATUS must not share a mark: `Megaphone` is the top bar's
    // "Building in public" badge.
    expect(entry!.icon).toBe(Globe);
    expect(entry!.icon).not.toBe(Megaphone);
  });

  it('is ABSENT off-cloud for an admin — the row, not merely the affordances', () => {
    expect(
      visibleSettingsNav(ADMIN, PROJECT_SETTINGS_NAV, SELF_HOSTED).map((e) => e.id),
    ).not.toContain('public-page');
    expect(visibleSettingsNav(ADMIN, PROJECT_SETTINGS_NAV, ON_CLOUD).map((e) => e.id)).toContain(
      'public-page',
    );
    // The palette reads the same registry through the same filter.
    expect(
      visibleSettingsNav(ADMIN, PROJECT_SETTINGS_ROUTES, SELF_HOSTED).map((e) => e.id),
    ).not.toContain('public-page');
  });

  it('is absent for a non-admin ON cloud too — the two axes COMPOSE, never substitute', () => {
    // The failure a single filter produces: a cloud build handing the room to
    // everyone because "it exists here".
    //
    // ⚠️ INVERTED BY MOTIR-5278 (§6 of the Approvals design). These read
    // `toEqual([])`, which proved public-page absent only because the whole rail
    // was empty. A member's rail now holds Approvals, so the absence is asserted on
    // the id the claim was always about, beside what the rail DOES hold.
    for (const held of [MEMBER, VIEWER]) {
      const ids = visibleSettingsNav(held, PROJECT_SETTINGS_NAV, ON_CLOUD).map((e) => e.id);
      expect(ids).not.toContain('public-page');
      expect(ids).toEqual(['approvals']);
    }
  });

  it('DEFAULTS CLOSED — a caller that forgets the deployment fact drops the row', () => {
    // The direction the default has to fail in: a rail row or a ⌘K action on a
    // self-hosted build opens onto a 404, which is the "door onto a corridor"
    // `hasVisibleSettingsArea` exists to refuse.
    expect(visibleSettingsNav(ADMIN).map((e) => e.id)).not.toContain('public-page');
    expect(visibleSettingsNav(ADMIN, PROJECT_SETTINGS_ROUTES).map((e) => e.id)).not.toContain(
      'public-page',
    );
  });

  it('the area DOOR reads the same two axes as the rows it opens onto', () => {
    // The door and the rail must not disagree about what the area contains — so
    // `hasVisibleSettingsArea` takes the availability too. Asserted over an
    // actor whose ONLY entry is the cloud-only one, which is the only shape that
    // can tell the two apart.
    const cloudOnlyKeys = new Set(
      PROJECT_SETTINGS_NAV.filter((e) => e.cloudOnly).map((e) => e.permission),
    );
    const alsoOpensSomethingElse = ALWAYS_PRESENT.some((e) => cloudOnlyKeys.has(e.permission));
    // Today `project:administer` also opens Details, so no such actor exists and
    // the door cannot move. Pinned as a MEASUREMENT rather than assumed: the day
    // a cloud-only room has a key of its own, this flips and the assertion below
    // starts doing real work instead of silently passing.
    expect(alsoOpensSomethingElse).toBe(true);
    for (const held of [ADMIN, MEMBER, VIEWER, NO_ACCESS]) {
      for (const available of [ON_CLOUD, SELF_HOSTED]) {
        expect(hasVisibleSettingsArea(held, available)).toBe(
          visibleSettingsNav(held, PROJECT_SETTINGS_NAV, available).length > 0,
        );
      }
    }
  });

  it('the route ↔ registry totality holds REGARDLESS of the flag — the page exists either way', () => {
    // `PROJECT_SETTINGS_ROUTE_PATHS` is derived from the registry, not from a
    // filtered view of it, so an off-cloud build still accounts for the file on
    // disk. The route answers `notFound()` there; it does not vanish.
    expect(PROJECT_SETTINGS_ROUTE_PATHS).toContain('/settings/project/public');
  });
});

describe('projectSettingsNav registry — grouping', () => {
  it('groups in rail order, only non-empty groups, entries within their group', () => {
    const groups = groupSettingsNav(PROJECT_SETTINGS_NAV);
    expect(groups.map((g) => g.group)).toEqual(SETTINGS_NAV_GROUP_ORDER);
    // `repositories` (MOTIR-1939) joins General BELOW Details: it is the
    // TAKE-IT-OVER room's permanent door, and a `transfer_pending` that sits for
    // days has to be reachable from the rail rather than only from the approval
    // step the user left weeks ago.
    expect(groups.find((g) => g.group === 'general')?.entries.map((e) => e.id)).toEqual([
      'details',
      'repositories',
    ]);
    expect(groups.find((g) => g.group === 'work')?.entries.map((e) => e.id)).toEqual([
      'workflow',
      // MOTIR-5170 — `approvals` sits directly after `workflow`, and the ORDER is
      // the assertion: a status graph and an approval gate are the two things that
      // decide when work may move, so they are neighbours rather than nested.
      'approvals',
      'board',
      'estimation',
      'fields',
      'components',
    ]);
  });

  it('drops groups with no visible entries', () => {
    const onlyDetails = PROJECT_SETTINGS_NAV.filter((e) => e.id === 'details');
    const groups = groupSettingsNav(onlyDetails);
    expect(groups.map((g) => g.group)).toEqual(['general']);
  });
});

describe('projectSettingsNav registry — active detection', () => {
  it('Details (exact) is active ONLY on the root, not on a sub-route', () => {
    const details = PROJECT_SETTINGS_NAV.find((e) => e.id === 'details')!;
    expect(isSettingsEntryActive(details, '/settings/project')).toBe(true);
    expect(isSettingsEntryActive(details, '/settings/project/workflow')).toBe(false);
  });

  it('a section entry is active on its route and any sub-path', () => {
    const board = PROJECT_SETTINGS_NAV.find((e) => e.id === 'board')!;
    expect(isSettingsEntryActive(board, '/settings/project/board')).toBe(true);
    // `?board=` is a query string, not a path segment — still the board route.
    expect(isSettingsEntryActive(board, '/settings/project/board')).toBe(true);
    expect(isSettingsEntryActive(board, '/settings/project/workflow')).toBe(false);
  });

  it('the Automation entry is active on its route, not on the area root', () => {
    const automation = PROJECT_SETTINGS_NAV.find((e) => e.id === 'automation')!;
    expect(isSettingsEntryActive(automation, '/settings/project')).toBe(false);
    expect(isSettingsEntryActive(automation, '/settings/project/automation')).toBe(true);
  });
});

describe('projectSettingsNav registry — isProjectSettingsPath', () => {
  it('matches the area root and its descendants', () => {
    expect(isProjectSettingsPath('/settings/project')).toBe(true);
    expect(isProjectSettingsPath('/settings/project/members')).toBe(true);
    expect(isProjectSettingsPath('/settings/project/board')).toBe(true);
  });

  it('does NOT match workspace settings or other routes', () => {
    expect(isProjectSettingsPath('/settings/workspace')).toBe(false);
    expect(isProjectSettingsPath('/settings/workspace/jobs')).toBe(false);
    expect(isProjectSettingsPath('/dashboard')).toBe(false);
    // not a false prefix match
    expect(isProjectSettingsPath('/settings/project-other')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Subtask MOTIR-2468 — the registry gates on NAMED PERMISSIONS.
//
// The card's central discipline: each entry's key was READ OFF its destination's
// own server gate, never inferred from the entry's name. A rail row that hides on
// a key the page does not check is a new bug wearing the shape of a fix, and it
// fails in the worst direction — it hides a room the actor could have used.
//
// ⚠️ WHAT THE SOURCE ASSERTIONS BELOW CAN AND CANNOT DO. They read the gate's
// SOURCE and check the key literal appears in it. That is a claim about what the
// file says, never about what the operation authorises (`notes.html` #231 — the
// whitelist-of-names lesson, logged against this very epic). Their job is
// narrow and real: pin the pairing so a later card that re-keys a service cannot
// silently leave a rail row gating on a key nobody asserts any more. The
// behavioural half is the role expectations further down, which run the real
// resolved sets through the real filter.
// ─────────────────────────────────────────────────────────────────────────────

/** Where each entry's key was read from, and the exact gate that asserts it. */
/**
 * Gates that assert their key through an ALIAS instead of naming it (MOTIR-4243).
 *
 * `projectAccessService.assertCanManage` IS
 * `assertPermission(…, 'project:administer')` — so a service that calls it DOES
 * assert the key, it just does not spell it, and a source grep for the literal
 * reads that as "asserts nothing". Accepting an alias would be a hole if the
 * alias could quietly come to mean something else, so the alias itself is pinned
 * at its definition below, which is the check the literal grep was standing in
 * for all along.
 *
 * ⚠️ KEYED ON THE QUALIFIED CALL, and that is not tidiness. `fields` and
 * `components` cite gates of their OWN named `assertCanManage` — module-private
 * helpers that assert `field:manage` and `component:manage`. A bare gate name
 * would resolve those two to `project:administer` and pass, which is this
 * mechanism failing in the direction that lets people into rooms.
 */
const ALIAS_ASSERTS: Record<string, PermissionKey> = {
  'projectAccessService.assertCanManage': 'project:administer',
};

const KEY_EVIDENCE: Record<string, { permission: PermissionKey; source: string; gate: string }> = {
  details: {
    permission: 'project:administer',
    source: 'lib/services/projectAccessService.ts',
    gate: 'getManageCapabilities',
  },
  repositories: {
    permission: 'repository:manage',
    source: 'lib/services/projectRepoSetService.ts',
    gate: 'assertPermission',
  },
  members: {
    permission: 'member:manage',
    source: 'lib/services/projectMembersService.ts',
    gate: 'assertPermission',
  },
  // The room's write is `projectsService.setPublicOverview` — the ACTIVE-PROJECT
  // author, which owns the write transaction and asserts `assertCanManage`
  // inside it. The key-routed door the room saves through
  // (`publicProjectsService.setPublicOverview`, `PATCH
  // /api/projects/{key}/public-overview`) refuses a non-admin ahead of it and
  // then delegates here, so this is the gate at the bottom of both paths.
  'public-page': {
    permission: 'project:administer',
    source: 'lib/services/projectsService.ts',
    gate: 'projectAccessService.assertCanManage',
  },
  // Roles has NO write of its own — a judgement, argued at the entry. Its key is
  // asserted by the service that owns the domain it belongs to.
  // ⚠️ RE-KEYED BY MOTIR-2257, AND THIS ROW IS WHY THE CHANGE WAS OWED. When
  // MOTIR-2468 wrote it, the roles screen had no service of its own, so its
  // evidence had to BORROW the members service — a rail row pointing at a gate
  // that governs a different destination. This story gave the screen three
  // writes (`Create role` / `Edit` / `Delete`) and a service that asserts
  // `project:manage_access` on every one of them, so the row now cites the code
  // the destination actually runs.
  roles: {
    permission: 'project:manage_access',
    source: 'lib/services/projectRoleDefinitionService.ts',
    gate: 'assertPermission',
  },
  'code-access': {
    permission: 'repository:manage_access',
    source: 'lib/services/projectRepoAccessService.ts',
    gate: 'assertPermission',
  },
  workflow: {
    permission: 'workflow:manage',
    source: 'lib/services/workflowsService.ts',
    gate: 'assertProjectAdmin',
  },
  // MOTIR-4925 · MOTIR-5170. The SAME write key as `workflow`, and deliberately: a
  // status graph and an approval gate are the two things that decide when work
  // may move. Unlike its neighbour this service names the gate plainly —
  // `projectAccessService.assertPermission(projectId, ctx, 'workflow:manage')` in
  // `updateSettings` — so the evidence is the literal.
  //
  // ⚠️ THIS ROW IS THE WRITE KEY'S EVIDENCE ONLY (MOTIR-5278). The READ,
  // `getSettings`, asserts `project:browse` now — that is the entry's VIEW key,
  // and its evidence row is `VIEW_KEY_EVIDENCE.approvals` below.
  approvals: {
    permission: 'workflow:manage',
    source: 'lib/services/approvalGateSettingsService.ts',
    gate: 'assertPermission',
  },
  board: {
    permission: 'board:configure',
    source: 'lib/services/boardsService.ts',
    gate: 'assertBoardConfigAdmin',
  },
  estimation: {
    permission: 'estimation:manage',
    source: 'lib/services/estimationService.ts',
    gate: 'assertEstimationAdmin',
  },
  fields: {
    permission: 'field:manage',
    source: 'lib/services/customFieldsService.ts',
    gate: 'assertCanManage',
  },
  components: {
    permission: 'component:manage',
    source: 'lib/services/componentsService.ts',
    gate: 'assertCanManage',
  },
  'ai-planning': {
    permission: 'ai:configure',
    source: 'lib/services/projectAiSettingsService.ts',
    gate: 'assertPermission',
  },
  automation: {
    permission: 'automation:manage',
    source: 'lib/services/automationRulesService.ts',
    gate: 'assertPermission',
  },
  // MOTIR-4221 — the Public address room. Its writes live in the customer-domain
  // lifecycle, which asserts `project:manage_access` on add / verify / remove /
  // makePrimary / clearPrimary. The room's OTHER half (the workspace subdomain)
  // is gated on the workspace ROLE, an axis the registry cannot express — see the
  // entry's own comment for why the project key is the honest one for the rail.
  'public-address': {
    permission: 'project:manage_access',
    source: 'lib/services/customDomainService.ts',
    gate: 'assertPermission',
  },
};

describe('every registry entry names the key its DESTINATION asserts (MOTIR-2468)', () => {
  it('covers the registry TOTALLY — a new entry with no evidence row fails here', () => {
    // The compile-time half is `permission` being required on SettingsNavEntry.
    // This is the other half: a new entry cannot ship with a key nobody checked.
    expect(PROJECT_SETTINGS_NAV.map((e) => e.id).sort()).toEqual(Object.keys(KEY_EVIDENCE).sort());
  });

  it.each(PROJECT_SETTINGS_NAV.map((e) => [e.id, e] as const))(
    '%s gates on the key its own service asserts',
    (id, entry) => {
      const evidence = KEY_EVIDENCE[id]!;
      expect(entry.permission).toBe(evidence.permission);
      const source = readFileSync(join(process.cwd(), evidence.source), 'utf8');
      expect(source, `${evidence.source} no longer contains ${evidence.gate}`).toContain(
        evidence.gate,
      );
      const aliased = ALIAS_ASSERTS[evidence.gate];
      if (aliased) {
        // The gate names no key because it IS one — see ALIAS_ASSERTS, and the
        // test below that pins what the alias resolves to.
        expect(
          aliased,
          `${evidence.source} reaches '${evidence.permission}' through ${evidence.gate}, which ` +
            `asserts '${aliased}' instead. Re-read the gate and re-key the entry.`,
        ).toBe(evidence.permission);
      } else {
        expect(
          source,
          `${evidence.source} no longer asserts '${evidence.permission}' — the rail row now gates ` +
            'on a key nothing checks. Re-read the gate and re-key the entry.',
        ).toContain(`'${evidence.permission}'`);
      }
    },
  );

  it('every ALIAS gate still asserts the key it is accepted for', () => {
    // What makes accepting an alias safe. Read at the DEFINITION, so an alias
    // that is re-pointed at another key fails here rather than silently widening
    // every entry that cites it.
    const src = readFileSync(join(process.cwd(), 'lib/services/projectAccessService.ts'), 'utf8');
    for (const [qualified, key] of Object.entries(ALIAS_ASSERTS)) {
      const gate = qualified.split('.').pop()!;
      const at = src.indexOf(`async ${gate}(`);
      expect(at, `${gate} is no longer defined in projectAccessService`).toBeGreaterThan(-1);
      const body = src.slice(at, at + 400);
      expect(body, `${gate} no longer resolves to '${key}'`).toContain(
        `this.assertPermission(projectId, ctx, '${key}'`,
      );
    }
  });

  it('names only real catalog keys', () => {
    for (const entry of PROJECT_SETTINGS_NAV) {
      expect(isPermissionKey(entry.permission), `${entry.id}: ${entry.permission}`).toBe(true);
    }
  });
});

describe('what each actor is offered (MOTIR-2468)', () => {
  it("an ADMIN's rail is byte-for-byte the rail that ships today", () => {
    // The regression that matters most: nothing an admin could reach was taken.
    expect(visibleSettingsNav(ADMIN, PROJECT_SETTINGS_NAV, ON_CLOUD)).toEqual(PROJECT_SETTINGS_NAV);
    expect(
      groupSettingsNav(visibleSettingsNav(ADMIN, PROJECT_SETTINGS_NAV, ON_CLOUD)).map(
        (g) => g.group,
      ),
    ).toEqual(SETTINGS_NAV_GROUP_ORDER);
  });

  // ⚠️ BOTH INVERTED BY MOTIR-5278, DELIBERATELY (`design/projects/design-notes.md`
  // § ⭐ Approvals §6, decided on MOTIR-5190). They read "a built-in MEMBER / VIEWER
  // is offered NOTHING — so the area door goes with it". `approvals` opens on
  // `project:browse`, so each is offered exactly that room, in the one `work`
  // group, and the door comes back — Amendment 2026-08-08 hides the door only when
  // EVERY entry filters away, and one no longer does.
  it('a built-in MEMBER is offered exactly Approvals — so the area door comes BACK', () => {
    expect(visibleSettingsNav(MEMBER).map((e) => e.id)).toEqual(['approvals']);
    expect(groupSettingsNav(visibleSettingsNav(MEMBER)).map((g) => g.group)).toEqual(['work']);
    expect(hasVisibleSettingsArea(MEMBER)).toBe(true);
  });

  it('a built-in VIEWER is offered exactly Approvals too', () => {
    expect(visibleSettingsNav(VIEWER).map((e) => e.id)).toEqual(['approvals']);
    expect(groupSettingsNav(visibleSettingsNav(VIEWER)).map((g) => g.group)).toEqual(['work']);
    expect(hasVisibleSettingsArea(VIEWER)).toBe(true);
  });

  it('an actor with no keys at all is offered NOTHING', () => {
    expect(visibleSettingsNav(NO_ACCESS)).toEqual([]);
    expect(hasVisibleSettingsArea(NO_ACCESS)).toBe(false);
  });

  it('the PER-DOMAIN case: board:configure and not member:manage yields Board, omits Members', () => {
    // The case two booleans could never express, and the parent story's own
    // integration-level assertion (MOTIR-2257 walks it with a live custom role).
    const held = toSettingsNavPermissions(['project:browse', 'board:configure']);
    const ids = visibleSettingsNav(held).map((e) => e.id);
    expect(ids).toContain('board');
    expect(ids).not.toContain('members');
    expect(ids).not.toContain('roles');
    expect(hasVisibleSettingsArea(held)).toBe(true);
  });

  it('a group whose entries ALL filtered away renders NO heading (design panel 2)', () => {
    // The failure a naive filter produces: a heading above nothing, which reads
    // as a loading error rather than as policy.
    const held = toSettingsNavPermissions(['board:configure', 'estimation:manage']);
    const groups = groupSettingsNav(visibleSettingsNav(held));
    expect(groups.map((g) => g.group)).toEqual(['work']);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(['board', 'estimation']);
    for (const group of groups) expect(group.entries.length).toBeGreaterThan(0);
  });

  it('hasVisibleSettingsArea agrees with the filter it quantifies over, for every key', () => {
    // The door and the rows can never disagree about what the area contains —
    // asserted over each key alone, not just the sets above.
    for (const key of PERMISSIONS) {
      const held = toSettingsNavPermissions([key]);
      expect(hasVisibleSettingsArea(held)).toBe(visibleSettingsNav(held).length > 0);
    }
  });

  // ⚠️ INVERTED BY MOTIR-5278, DELIBERATELY (§6 of the Approvals design). This read
  // "`project:browse` alone opens NO door", pinned by MOTIR-2468 because while any
  // entry gated on browse the door could never disappear for anyone. That is now
  // the decided product: ONE room opens on browse, as a VIEW key, onto a room the
  // actor may read and not change. What stays pinned is the half that still
  // matters — no entry's WRITE key is browse, because a browse-gated CONTROL would
  // be the defect MOTIR-2468 removed.
  it('`project:browse` alone opens exactly Approvals — the only entry declaring it as a VIEW key', () => {
    const browser = toSettingsNavPermissions(['project:browse']);
    expect(visibleSettingsNav(browser).map((e) => e.id)).toEqual(['approvals']);
    expect(hasVisibleSettingsArea(browser)).toBe(true);
    expect(PROJECT_SETTINGS_NAV.map((e) => e.permission)).not.toContain('project:browse');
    expect(
      PROJECT_SETTINGS_NAV.filter((e) => e.viewPermission === 'project:browse').map((e) => e.id),
    ).toEqual(['approvals']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task MOTIR-5193 — a VIEW key distinct from the WRITE key.
//
// An entry may now declare `viewPermission`: the key that opens its DOOR, apart
// from `permission`, the key its CONTROLS require. The rail row, the area door
// and the destination guard read the view key; the write key gates nothing on
// arrival. Everything below is proven twice: over the real registry, where the
// change must be invisible for every ONE-key entry, and over a FIXTURE, where it
// must be visible. Since MOTIR-5278 the real registry carries its first declaring
// entry, `approvals`, so the drift test bites on shipped code too.
//
// ⚠️ THE DRIFT TEST IS THE POINT OF THE CARD. The one-key model made the row and
// the page structurally unable to disagree; two keys make it possible again, and
// a comment asking for care is exactly what stops working once there are two keys
// to align. So the alignment is a test, and the test is shown to FIRE.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether `entry` exists on a build with `available` — the registry's own axis, restated. */
function existsOn(entry: SettingsNavEntry, available: { publicProjectsAvailable: boolean }) {
  return !entry.cloudOnly || available.publicProjectsAvailable;
}

describe('the VIEW key defaults to the WRITE key — the no-regression proof (MOTIR-5193)', () => {
  // ⚠️ AMENDED BY MOTIR-5278. Both cases below held over EVERY shipped entry while
  // none declared a view key. `approvals` now does (§6 of the Approvals design), so
  // each is restated with that ONE exception named: for every other entry the
  // second key must still change nothing, and for `approvals` the change IS the
  // decision — so it is spelled out here rather than derived through the helper
  // under test.
  /** The one-key model, restated — with the single decided exception. */
  const expectedViewKey = (entry: SettingsNavEntry): PermissionKey =>
    entry.id === 'approvals' ? 'project:browse' : entry.permission;

  it('every ONE-key entry’s effective view key IS its permission, and approvals is the exception', () => {
    const oneKey = PROJECT_SETTINGS_NAV.filter((e) => e.id !== 'approvals');
    expect(oneKey).toHaveLength(PROJECT_SETTINGS_NAV.length - 1);
    for (const entry of oneKey) {
      expect(settingsEntryViewKey(entry), entry.id).toBe(entry.permission);
      expect(settingsEntryKeys(entry.id), entry.id).toEqual({
        view: entry.permission,
        write: entry.permission,
      });
    }
    expect(settingsEntryKeys('approvals')).toEqual({
      view: 'project:browse',
      write: 'workflow:manage',
    });
  });

  it('the view-gated rail, door and refusal differ from the write-gated ones by EXACTLY Approvals', () => {
    // Every single-key actor in the catalog, plus every built-in role and nobody
    // at all, on both builds. The expectation is written here on `permission`
    // alone plus the one named exception, so a change in what any actor is offered
    // anywhere fails this, not merely a change in count.
    const actors = [
      ...PERMISSIONS.map((key) => toSettingsNavPermissions([key])),
      ADMIN,
      MEMBER,
      VIEWER,
      NO_ACCESS,
    ];
    for (const held of actors) {
      for (const available of [ON_CLOUD, SELF_HOSTED]) {
        const expected = PROJECT_SETTINGS_NAV.filter(
          (e) => existsOn(e, available) && held.has(expectedViewKey(e)),
        );
        expect(visibleSettingsNav(held, PROJECT_SETTINGS_NAV, available)).toEqual(expected);
        expect(hasVisibleSettingsArea(held, available)).toBe(expected.length > 0);
      }
      for (const entry of PROJECT_SETTINGS_NAV) {
        expect(resolveSettingsRefusal(entry.id, held) === null).toBe(
          held.has(expectedViewKey(entry)),
        );
      }
    }
  });
});

/**
 * Two entries, and the second declares a distinct view key. The first carries a
 * key a browser does not hold, so its write-gated and view-gated rails DIFFER for
 * a browser — the shape that can tell the two filters apart.
 */
const FIXTURE_ROOM = '/settings/project/fixture-room';
const FIXTURE: SettingsNavEntry[] = [
  {
    id: 'fixture-admin',
    group: 'general',
    href: PROJECT_SETTINGS_ROOT,
    icon: Globe,
    labelKey: 'nav.details',
    permission: 'project:administer',
    exact: true,
  },
  {
    id: 'fixture-room',
    group: 'work',
    href: FIXTURE_ROOM,
    icon: Globe,
    labelKey: 'nav.approvals',
    viewPermission: 'project:browse',
    permission: 'workflow:manage',
  },
];
const BROWSER = toSettingsNavPermissions(['project:browse']);
const WRITER_ONLY = toSettingsNavPermissions(['workflow:manage']);

describe('a distinct VIEW key opens the door, and only the door (MOTIR-5193, over a fixture)', () => {
  it('an actor holding only the view key SEES the row, and the area door agrees', () => {
    expect(visibleSettingsNav(BROWSER, FIXTURE).map((e) => e.id)).toEqual(['fixture-room']);
    for (const held of [BROWSER, WRITER_ONLY, NO_ACCESS, ADMIN]) {
      for (const available of [ON_CLOUD, SELF_HOSTED]) {
        expect(hasVisibleSettingsArea(held, available, FIXTURE)).toBe(
          visibleSettingsNav(held, FIXTURE, available).length > 0,
        );
      }
    }
  });

  it('the WRITE key opens nothing on its own — it is what the room renders, not what admits', () => {
    expect(visibleSettingsNav(WRITER_ONLY, FIXTURE)).toEqual([]);
    expect(hasVisibleSettingsArea(WRITER_ONLY, SELF_HOSTED, FIXTURE)).toBe(false);
  });

  it('the refusal is decided by the view key — open to a browser, refused to an actor with neither', () => {
    expect(resolveSettingsRefusal('fixture-room', BROWSER, FIXTURE)).toBeNull();
    expect(resolveSettingsRefusal('fixture-room', NO_ACCESS, FIXTURE)).toEqual({
      descriptionKey: 'noAccess.section.fixture-room',
      backHref: '/dashboard',
      backLabelKey: null,
    });
    expect(resolveSettingsRefusal('fixture-room', WRITER_ONLY, FIXTURE)).not.toBeNull();
  });

  it('back is drawn from the VIEW-filtered rail — a room the refused actor CAN open', () => {
    // The trap the helper was written against, moved by the second key: for a
    // browser the WRITE-filtered rail over this fixture is EMPTY, so a back-link
    // drawn from it would throw them out of the area; the view-filtered one lands
    // on the room they may read.
    expect(FIXTURE.filter((e) => BROWSER.has(e.permission))).toEqual([]);
    const refusal = resolveSettingsRefusal('fixture-admin', BROWSER, FIXTURE)!;
    expect(refusal.backHref).toBe(FIXTURE_ROOM);
    expect(refusal.backLabelKey).toBe('nav.approvals');
    expect(resolveSettingsRefusal('fixture-room', BROWSER, FIXTURE)).toBeNull();
  });

  it('settingsEntryKeys reads both keys off the entry, and refuses an id it does not carry', () => {
    expect(settingsEntryKeys('fixture-room', FIXTURE)).toEqual({
      view: 'project:browse',
      write: 'workflow:manage',
    });
    expect(settingsEntryKeys('fixture-admin', FIXTURE)).toEqual({
      view: 'project:administer',
      write: 'project:administer',
    });
    expect(() => settingsEntryKeys('not-an-entry' as never, FIXTURE)).toThrow(
      /No settings registry entry/,
    );
  });
});

/**
 * Where each view-key-declaring entry's key was read from — the destination READ
 * that asserts it. The same discipline as {@link KEY_EVIDENCE}, one axis over:
 * a rail row opening on a key the room's own read does not admit is a door onto
 * an error page.
 *
 * Total over the declaring entries (asserted below), so a room cannot declare a
 * view key without its row here. MOTIR-5278 wrote the first one.
 */
const VIEW_KEY_EVIDENCE: Record<string, { source: string; gate: string }> = {
  // `getSettings` is the room's READ, and it asserts `project:browse` — the key the
  // entry opens its door on. The WRITE key's evidence stays in `KEY_EVIDENCE`.
  approvals: { source: 'lib/services/approvalGateSettingsService.ts', gate: 'getSettings' },
};

/** The repo-relative `page.tsx` a settings route renders from. */
function pageFileFor(route: string): string {
  return join(
    'app/(authed)/settings/project',
    route.slice(PROJECT_SETTINGS_ROOT.length),
    'page.tsx',
  );
}

/**
 * Every way a view-key-declaring entry has drifted from its destination, as one
 * message per finding naming the file and BOTH keys. Empty means aligned.
 *
 * Three checks per declaring entry, each the half of the one-key guarantee that a
 * second key can break:
 *   1. every destination page (`href` + `nestedRoutes`) guards on THIS entry, so
 *      the key that opens the door is the key the page checks;
 *   2. no destination page types the WRITE key as a literal — it reads it off
 *      the registry (`settingsEntryKeys(id).write`) so the controls it renders and
 *      the key the registry names cannot come apart;
 *   3. an evidence row names the destination READ, and that source asserts the
 *      VIEW key — or the door admits an actor the room's own read then refuses.
 *
 * Pure over its inputs, so it runs identically over the real tree and over a
 * fixture built to drift.
 */
function viewKeyDrift(
  entries: SettingsNavEntry[],
  readFile: (repoPath: string) => string | null,
  evidence: Record<string, { source: string; gate: string }>,
): string[] {
  const findings: string[] = [];
  for (const entry of entries) {
    if (!entry.viewPermission) continue;
    const view = entry.viewPermission;
    const write = entry.permission;
    const keys = `(view '${view}', write '${write}')`;

    for (const route of [entry.href, ...(entry.nestedRoutes ?? [])]) {
      const file = pageFileFor(route);
      const source = readFile(file);
      if (source === null) {
        findings.push(`${file}: no page for "${entry.id}" ${keys}`);
        continue;
      }
      if (!source.includes(`await guardSettingsPage('${entry.id}'`)) {
        findings.push(
          `${file} does not guard on "${entry.id}", so the door key is not what this page checks ${keys}`,
        );
      }
      if (source.includes(`'${write}'`)) {
        findings.push(
          `${file} re-declares the write key instead of reading settingsEntryKeys('${entry.id}').write ${keys}`,
        );
      }
    }

    const row = evidence[entry.id];
    if (!row) {
      findings.push(
        `"${entry.id}" declares a view key with no evidence row naming the destination read that asserts it ${keys}`,
      );
      continue;
    }
    const read = readFile(row.source);
    if (read === null || !read.includes(row.gate) || !read.includes(`'${view}'`)) {
      findings.push(
        `${row.source}: ${row.gate} does not assert the view key for "${entry.id}" — the door admits an actor the room's read refuses ${keys}`,
      );
    }
  }
  return findings;
}

function readRepoFile(repoPath: string): string | null {
  const abs = join(process.cwd(), repoPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

describe('the VIEW key cannot drift from its destination (MOTIR-5193)', () => {
  const declaring = PROJECT_SETTINGS_NAV.filter((e) => e.viewPermission);

  it('pins how many shipped entries declare a view key — a MEASUREMENT, not a target', () => {
    // The drift test below is vacuous over zero entries, and a guard that silently
    // walks an empty population passes for ever — so the count is pinned, and
    // updated in the SAME change as a declaration.
    //
    // ⚠️ UPDATED BY MOTIR-5278, exactly as this line asked. It was `[]`, over which
    // the drift test passed trivially; `approvals` is the first REAL declaring
    // entry, so from here the drift test rules on shipped code and not only on the
    // fixture. (The fixture tests below are still what prove it CAN fire.)
    expect(declaring.map((e) => e.id)).toEqual(['approvals']);
  });

  it('every declaring entry has an evidence row, and every evidence row a declaring entry', () => {
    expect(Object.keys(VIEW_KEY_EVIDENCE).sort()).toEqual(declaring.map((e) => e.id).sort());
  });

  it('the shipped registry has no drift', () => {
    expect(viewKeyDrift(PROJECT_SETTINGS_NAV, readRepoFile, VIEW_KEY_EVIDENCE)).toEqual([]);
  });

  describe('…and the test FIRES on a fixture that drifts on purpose', () => {
    const PAGE = pageFileFor(FIXTURE_ROOM);
    const SERVICE = 'lib/services/fixtureRoomService.ts';
    const EVIDENCE = { 'fixture-room': { source: SERVICE, gate: 'getFixtureRoom' } };
    const ALIGNED_PAGE = [
      "const refused = await guardSettingsPage('fixture-room', ctx);",
      'if (refused) return refused;',
      "const canManage = held.has(settingsEntryKeys('fixture-room').write);",
    ].join('\n');
    const ALIGNED_SERVICE =
      "async getFixtureRoom(projectId, ctx) { await assertPermission(projectId, ctx, 'project:browse'); }";

    const files =
      (overrides: Record<string, string | null>) =>
      (repoPath: string): string | null => {
        const tree: Record<string, string | null> = {
          [PAGE]: ALIGNED_PAGE,
          [SERVICE]: ALIGNED_SERVICE,
          ...overrides,
        };
        return repoPath in tree ? tree[repoPath]! : null;
      };

    it('an ALIGNED fixture reports nothing — so each finding below is the drift, not the fixture', () => {
      expect(viewKeyDrift(FIXTURE, files({}), EVIDENCE)).toEqual([]);
    });

    it('fires when the page guards on a DIFFERENT entry, naming the file and both keys', () => {
      const drifted = ALIGNED_PAGE.replace("'fixture-room', ctx", "'fixture-admin', ctx");
      const findings = viewKeyDrift(FIXTURE, files({ [PAGE]: drifted }), EVIDENCE);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain(PAGE);
      expect(findings[0]).toContain("view 'project:browse'");
      expect(findings[0]).toContain("write 'workflow:manage'");
      expect(findings[0]).toContain('does not guard on "fixture-room"');
    });

    it('fires when the page RE-DECLARES the write key, naming the file and both keys', () => {
      const drifted = `${ALIGNED_PAGE}\nconst canManage = held.has('workflow:manage');`;
      const findings = viewKeyDrift(FIXTURE, files({ [PAGE]: drifted }), EVIDENCE);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain(PAGE);
      expect(findings[0]).toContain("view 'project:browse'");
      expect(findings[0]).toContain("write 'workflow:manage'");
      expect(findings[0]).toContain('re-declares the write key');
    });

    it('fires when the destination READ asserts the WRITE key instead of the view key', () => {
      const drifted = ALIGNED_SERVICE.replace("'project:browse'", "'workflow:manage'");
      const findings = viewKeyDrift(FIXTURE, files({ [SERVICE]: drifted }), EVIDENCE);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain(SERVICE);
      expect(findings[0]).toContain("view 'project:browse'");
      expect(findings[0]).toContain("write 'workflow:manage'");
    });

    it('fires when a declaring entry has NO evidence row, and when its page does not exist', () => {
      expect(viewKeyDrift(FIXTURE, files({}), {})).toEqual([
        expect.stringContaining('declares a view key with no evidence row'),
      ]);
      const missingPage = viewKeyDrift(FIXTURE, files({ [PAGE]: null }), EVIDENCE);
      expect(missingPage).toEqual([expect.stringContaining(`${PAGE}: no page for "fixture-room"`)]);
    });
  });
});
