import { readFileSync, readdirSync } from 'node:fs';
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
  toSettingsNavPermissions,
  visibleSettingsNav,
} from '@/lib/settings/projectSettingsNav';
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
    expect(roles?.placeholder).toBeUndefined();
    // MOTIR-2468 retired the browse gate this entry shipped with. `member:manage`
    // is a JUDGEMENT (the page has no write of its own): the screen is the
    // reference behind the Members role picker, the catalog files role-shaped
    // keys under the `member` domain, and MOTIR-2257 adds role AUTHORING here.
    expect(roles?.permission).toBe('member:manage');
    expect(visibleSettingsNav(MEMBER).map((e) => e.id)).not.toContain('roles');
    expect(visibleSettingsNav(ADMIN).map((e) => e.id)).toContain('roles');
    expect(roles?.nestedRoutes).toEqual(['/settings/project/roles/[roleKey]']);
    // Rail order within Access — the model sits between who is on the team and
    // who can clone the code (design/projects/design-notes.md, access path).
    const accessIds = groupSettingsNav(PROJECT_SETTINGS_NAV)
      .find((g) => g.group === 'access')!
      .entries.map((e) => e.id);
    expect(accessIds).toEqual(['members', 'roles', 'code-access']);
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
    expect(automation?.placeholder).toBeUndefined();
    expect(automation?.href).toBe('/settings/project/automation');
    // It joins the real route set (the totality test pairs it with the
    // on-disk automation/page.tsx).
    expect(PROJECT_SETTINGS_ROUTES).toContainEqual(expect.objectContaining({ id: 'automation' }));
  });

  it('AI planning is a real browse-gated route ABOVE Rules in Automation (MOTIR-919)', () => {
    const aiPlanning = PROJECT_SETTINGS_NAV.find((e) => e.id === 'ai-planning');
    expect(aiPlanning?.href).toBe('/settings/project/ai-planning');
    expect(aiPlanning?.labelKey).toBe('nav.aiPlanning');
    expect(aiPlanning?.placeholder).toBeUndefined();
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
    expect(visibleSettingsNav(ADMIN)).toEqual(PROJECT_SETTINGS_NAV);
    expect(visibleSettingsNav(ADMIN, PROJECT_SETTINGS_ROUTES)).toEqual(PROJECT_SETTINGS_ROUTES);
  });

  // ⚠️ THIS ASSERTION WAS INVERTED BY MOTIR-2468, DELIBERATELY. It read "a member
  // sees every section EXCEPT Automation", which was the 2026-06-09 directive's
  // read-only-for-a-non-admin model. That directive is SUPERSEDED — see
  // `design/projects/design-notes.md` § *Amendment 2026-08-08*, which hides an
  // entry point whose destination the actor cannot use at all. Eleven of twelve
  // entries flipped; the twelfth (Automation) was already right.
  it('a member sees NO section — every entry gates on an administrative key now', () => {
    expect(visibleSettingsNav(MEMBER)).toEqual([]);
    expect(visibleSettingsNav(MEMBER, PROJECT_SETTINGS_ROUTES)).toEqual([]);
  });

  it('a no-browse actor sees NOTHING — the whole area filters away (no nav leak)', () => {
    expect(visibleSettingsNav(NO_ACCESS)).toEqual([]);
    expect(visibleSettingsNav(NO_ACCESS, PROJECT_SETTINGS_ROUTES)).toEqual([]);
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
  // Roles has NO write of its own — a judgement, argued at the entry. Its key is
  // asserted by the service that owns the domain it belongs to.
  roles: {
    permission: 'member:manage',
    source: 'lib/services/projectMembersService.ts',
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
      expect(
        source,
        `${evidence.source} no longer asserts '${evidence.permission}' — the rail row now gates ` +
          'on a key nothing checks. Re-read the gate and re-key the entry.',
      ).toContain(`'${evidence.permission}'`);
    },
  );

  it('names only real catalog keys', () => {
    for (const entry of PROJECT_SETTINGS_NAV) {
      expect(isPermissionKey(entry.permission), `${entry.id}: ${entry.permission}`).toBe(true);
    }
  });
});

describe('what each actor is offered (MOTIR-2468)', () => {
  it("an ADMIN's rail is byte-for-byte the rail that ships today", () => {
    // The regression that matters most: nothing an admin could reach was taken.
    expect(visibleSettingsNav(ADMIN)).toEqual(PROJECT_SETTINGS_NAV);
    expect(groupSettingsNav(visibleSettingsNav(ADMIN)).map((g) => g.group)).toEqual(
      SETTINGS_NAV_GROUP_ORDER,
    );
  });

  it('a built-in MEMBER is offered NOTHING — so the area door goes with it', () => {
    expect(visibleSettingsNav(MEMBER)).toEqual([]);
    expect(hasVisibleSettingsArea(MEMBER)).toBe(false);
  });

  it('a built-in VIEWER is offered NOTHING either', () => {
    expect(visibleSettingsNav(VIEWER)).toEqual([]);
    expect(hasVisibleSettingsArea(VIEWER)).toBe(false);
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

  it('`project:browse` alone opens NO door — the entry that used to make it do so is re-keyed', () => {
    // Every actor who reaches the shell holds `project:browse`. While ANY entry
    // gated on it, the area door could never disappear for anyone, and the
    // story's headline was unreachable. This is that invariant, pinned.
    expect(PROJECT_SETTINGS_NAV.map((e) => e.permission)).not.toContain('project:browse');
    expect(hasVisibleSettingsArea(toSettingsNavPermissions(['project:browse']))).toBe(false);
  });
});
