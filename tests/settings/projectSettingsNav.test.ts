import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_SETTINGS_NAV,
  PROJECT_SETTINGS_ROOT,
  PROJECT_SETTINGS_ROUTES,
  PROJECT_SETTINGS_ROUTE_PATHS,
  SETTINGS_NAV_GROUP_ORDER,
  groupSettingsNav,
  isProjectSettingsPath,
  isSettingsEntryActive,
  visibleSettingsNav,
  type SettingsNavCapabilities,
} from '@/lib/settings/projectSettingsNav';

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

const ADMIN: SettingsNavCapabilities = { canBrowse: true, canManage: true };
const MEMBER: SettingsNavCapabilities = { canBrowse: true, canManage: false };
const NO_ACCESS: SettingsNavCapabilities = { canBrowse: false, canManage: false };

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

  it('Roles & permissions is a browse-gated Access entry with the detail as its drill-down', () => {
    const roles = PROJECT_SETTINGS_NAV.find((e) => e.id === 'roles');
    expect(roles?.href).toBe('/settings/project/roles');
    expect(roles?.group).toBe('access');
    expect(roles?.labelKey).toBe('nav.roles');
    expect(roles?.placeholder).toBeUndefined();
    // Browse-gated like every other Access entry — a member READS what the roles
    // mean. Making that a permission predicate is MOTIR-2258's job.
    expect(roles?.access(MEMBER)).toBe(true);
    expect(roles?.access(NO_ACCESS)).toBe(false);
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
    // Browse-gated, NOT admin-gated: every member SEES the cadence config and a
    // non-admin reads it read-only (unlike the admin-only Rules row).
    expect(aiPlanning?.access({ canBrowse: true, canManage: false })).toBe(true);
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

  it('a member sees every section EXCEPT Automation (admin-only, no read-only variant)', () => {
    const memberNav = visibleSettingsNav(MEMBER);
    expect(memberNav.map((e) => e.id)).not.toContain('automation');
    // Everything else (the browse-gated sections) stays visible to a member.
    expect(memberNav).toEqual(PROJECT_SETTINGS_NAV.filter((e) => e.id !== 'automation'));
    expect(visibleSettingsNav(MEMBER, PROJECT_SETTINGS_ROUTES)).toEqual(
      PROJECT_SETTINGS_ROUTES.filter((e) => e.id !== 'automation'),
    );
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
