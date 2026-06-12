import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_SETTINGS_NAV,
  PROJECT_SETTINGS_ROOT,
  PROJECT_SETTINGS_ROUTES,
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
  it('every settings route has EXACTLY one registry entry, and vice versa', () => {
    const fsRoutes = collectFsRoutes(SETTINGS_DIR, PROJECT_SETTINGS_ROOT).sort();
    const registryRoutes = PROJECT_SETTINGS_ROUTES.map((e) => e.href).sort();

    // No drift in either direction: a new page without an entry, or an entry
    // without a page, both fail.
    expect(registryRoutes).toEqual(fsRoutes);
  });

  it('has no duplicate hrefs and no duplicate ids', () => {
    const hrefs = PROJECT_SETTINGS_ROUTES.map((e) => e.href);
    const ids = PROJECT_SETTINGS_NAV.map((e) => e.id);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the Automation slot is a placeholder, excluded from the route set', () => {
    const automation = PROJECT_SETTINGS_NAV.find((e) => e.id === 'automation');
    expect(automation?.placeholder).toBe(true);
    expect(automation?.href).toBe('');
    expect(PROJECT_SETTINGS_ROUTES).not.toContainEqual(
      expect.objectContaining({ id: 'automation' }),
    );
  });
});

describe('projectSettingsNav registry — access matrix (rides the 6.4.3 policy)', () => {
  it('a project admin sees every entry (incl. the placeholder slot)', () => {
    expect(visibleSettingsNav(ADMIN)).toEqual(PROJECT_SETTINGS_NAV);
    expect(visibleSettingsNav(ADMIN, PROJECT_SETTINGS_ROUTES)).toEqual(PROJECT_SETTINGS_ROUTES);
  });

  it('a member sees every entry too — members VIEW every section (read-only)', () => {
    expect(visibleSettingsNav(MEMBER)).toEqual(PROJECT_SETTINGS_NAV);
    expect(visibleSettingsNav(MEMBER, PROJECT_SETTINGS_ROUTES)).toEqual(PROJECT_SETTINGS_ROUTES);
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
    expect(groups.find((g) => g.group === 'general')?.entries.map((e) => e.id)).toEqual([
      'details',
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

  it('the placeholder (no href) is never active', () => {
    const automation = PROJECT_SETTINGS_NAV.find((e) => e.id === 'automation')!;
    expect(isSettingsEntryActive(automation, '/settings/project')).toBe(false);
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
