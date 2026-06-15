import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_SETTINGS_NAV,
  ACCOUNT_SETTINGS_NAV_GROUP_ORDER,
  ACCOUNT_SETTINGS_ROOT,
  ACCOUNT_SETTINGS_ROUTES,
  groupAccountSettingsNav,
  isAccountSettingsEntryActive,
  isAccountSettingsPath,
} from '@/lib/settings/accountSettingsNav';

// Subtask 7.8.12 — the account-settings-nav registry is the single source for the
// area nav, the command-palette deep links, AND this totality guard. The suite
// fails the moment the registry and the filesystem routes drift apart (mistake
// #29), and pins the grouping + active-detection contract the rail/palette rely
// on. Mirrors `tests/settings/projectSettingsNav.test.ts` (the 6.5 precedent).

const SETTINGS_DIR = join(process.cwd(), 'app/(authed)/settings/account');

/** Enumerate the on-disk `settings/account/**​/page.tsx` routes → their URL paths. */
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

describe('accountSettingsNav registry — totality (route ↔ entry, mistake #29)', () => {
  it('every account-settings pane route has EXACTLY one registry entry, and vice versa', () => {
    // The area ROOT (`/settings/account`) is a redirect to the first real pane, not
    // a nav destination, so it carries no registry entry — exclude it from the
    // pairing (unlike the project area, whose root IS the Details entry).
    const fsRoutes = collectFsRoutes(SETTINGS_DIR, ACCOUNT_SETTINGS_ROOT)
      .filter((route) => route !== ACCOUNT_SETTINGS_ROOT)
      .sort();
    const registryRoutes = ACCOUNT_SETTINGS_ROUTES.map((e) => e.href).sort();

    // No drift in either direction: a new pane without an entry, or an entry
    // without a pane, both fail.
    expect(registryRoutes).toEqual(fsRoutes);
  });

  it('the area root is a real page (the redirect) but never a registry entry', () => {
    const fsRoutes = collectFsRoutes(SETTINGS_DIR, ACCOUNT_SETTINGS_ROOT);
    expect(fsRoutes).toContain(ACCOUNT_SETTINGS_ROOT);
    expect(ACCOUNT_SETTINGS_ROUTES.map((e) => e.href)).not.toContain(ACCOUNT_SETTINGS_ROOT);
  });

  it('has no duplicate hrefs and no duplicate ids', () => {
    const hrefs = ACCOUNT_SETTINGS_ROUTES.map((e) => e.href);
    const ids = ACCOUNT_SETTINGS_NAV.map((e) => e.id);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reserves Profile / Appearance / API tokens as designed-for "Soon" placeholders', () => {
    const placeholders = ACCOUNT_SETTINGS_NAV.filter((e) => e.placeholder).map((e) => e.id);
    expect(placeholders).toEqual(['profile', 'appearance', 'apiTokens']);
    // A placeholder carries no route, so it never enters the real-route set.
    for (const entry of ACCOUNT_SETTINGS_NAV.filter((e) => e.placeholder)) {
      expect(entry.href).toBe('');
      expect(ACCOUNT_SETTINGS_ROUTES).not.toContainEqual(entry);
    }
  });
});

describe('accountSettingsNav registry — grouping', () => {
  it('groups in rail order, only non-empty groups, entries within their group', () => {
    const groups = groupAccountSettingsNav(ACCOUNT_SETTINGS_NAV);
    expect(groups.map((g) => g.group)).toEqual(ACCOUNT_SETTINGS_NAV_GROUP_ORDER);
    expect(groups.find((g) => g.group === 'general')?.entries.map((e) => e.id)).toEqual([
      'profile',
    ]);
    expect(groups.find((g) => g.group === 'preferences')?.entries.map((e) => e.id)).toEqual([
      'language',
      'notifications',
      'appearance',
    ]);
    expect(groups.find((g) => g.group === 'security')?.entries.map((e) => e.id)).toEqual([
      'apiTokens',
    ]);
  });

  it('drops groups with no entries', () => {
    const onlyLanguage = ACCOUNT_SETTINGS_NAV.filter((e) => e.id === 'language');
    const groups = groupAccountSettingsNav(onlyLanguage);
    expect(groups.map((g) => g.group)).toEqual(['preferences']);
  });
});

describe('accountSettingsNav registry — active detection', () => {
  it('a pane entry is active on its route and any sub-path', () => {
    const language = ACCOUNT_SETTINGS_NAV.find((e) => e.id === 'language')!;
    expect(isAccountSettingsEntryActive(language, '/settings/account/language')).toBe(true);
    expect(isAccountSettingsEntryActive(language, '/settings/account/notifications')).toBe(false);
  });

  it('a placeholder (no href) is never active', () => {
    const profile = ACCOUNT_SETTINGS_NAV.find((e) => e.id === 'profile')!;
    expect(isAccountSettingsEntryActive(profile, '/settings/account')).toBe(false);
    expect(isAccountSettingsEntryActive(profile, '/settings/account/language')).toBe(false);
  });
});

describe('accountSettingsNav registry — isAccountSettingsPath', () => {
  it('matches the area root and its descendants', () => {
    expect(isAccountSettingsPath('/settings/account')).toBe(true);
    expect(isAccountSettingsPath('/settings/account/language')).toBe(true);
    expect(isAccountSettingsPath('/settings/account/notifications')).toBe(true);
  });

  it('does NOT match project/workspace settings or other routes', () => {
    expect(isAccountSettingsPath('/settings/project')).toBe(false);
    expect(isAccountSettingsPath('/settings/workspace')).toBe(false);
    expect(isAccountSettingsPath('/dashboard')).toBe(false);
    // not a false prefix match
    expect(isAccountSettingsPath('/settings/account-other')).toBe(false);
  });
});
