import { Bot, Box, Columns3, Gauge, SlidersHorizontal, Tag, Users, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// The project-settings navigation REGISTRY (Story 6.5 · Subtask 6.5.2) — ONE
// typed entry per project-settings page. It is the single source that drives
// three surfaces, so they can never drift apart:
//   1. the settings AREA nav (the rail, rendered by SidebarNav when in the area)
//   2. the command-palette deep links (AppCommandPalette)
//   3. the TOTALITY test (every `settings/project/**/page.tsx` route has EXACTLY
//      one registry entry, and vice versa — the mistake #29 totality guard;
//      `tests/settings/projectSettingsNav.test.ts` enumerates the filesystem).
//
// A later admin story mounts its page by ADDING an entry here — no layout change
// (the Automation slot below is the worked example: a designed-for "Soon" row
// reserved for Story 6.6). The asset of record is
// `design/projects/settings-area.mock.html` (6.5.1).
//
// This module is pure data + pure helpers (no JSX, no React state), so it is
// importable from both the server (the totality test, a future server filter)
// and the client (SidebarNav, the command palette) and is unit-testable in
// isolation. `icon` is the lucide COMPONENT (not a rendered element); the
// consumer renders `<entry.icon />`.

export type SettingsNavGroup = 'general' | 'access' | 'work' | 'automation';

/** Rail order of the groups (General → Access → Work → Automation). */
export const SETTINGS_NAV_GROUP_ORDER: SettingsNavGroup[] = [
  'general',
  'access',
  'work',
  'automation',
];

/**
 * The actor capabilities a registry entry's `access` predicate decides over — a
 * subset of the shipped 6.4.3 policy (`projectAccessService.getSettingsCapabilities`).
 * Every current entry gates on `canBrowse` (a member VIEWS every section — the
 * design's role-states rule); `canManage` is threaded for the admin-only entries
 * a later story (6.6 Automation) will add, so the predicate shape never changes.
 */
export interface SettingsNavCapabilities {
  canBrowse: boolean;
  canManage: boolean;
}

export interface SettingsNavEntry {
  /** Stable id — also the command-palette action id (`settings-<id>`). */
  id: string;
  group: SettingsNavGroup;
  /** The preserved settings route this entry navigates to. Empty for a placeholder slot. */
  href: string;
  /** The lucide icon COMPONENT (the consumer renders it). */
  icon: LucideIcon;
  /** i18n key under the `settings` namespace (e.g. `nav.details`). */
  labelKey: string;
  /** Visibility predicate over the actor's capabilities. */
  access: (caps: SettingsNavCapabilities) => boolean;
  /**
   * Active ONLY on an exact pathname match. Set for Details, whose href
   * (`/settings/project`) is a prefix of every sub-route — without this it would
   * read as active on every settings page.
   */
  exact?: boolean;
  /**
   * A designed-for, not-yet-built slot (the 6.6 Automation row). Rendered as a
   * disabled "Soon" row so the area's shape is legible from day one, but it is
   * NOT a real route — excluded from the route↔registry totality assertion and
   * from the command palette. Becomes a normal entry when 6.6 ships its page.
   */
  placeholder?: boolean;
}

/** The project-settings root — the Details landing route. */
export const PROJECT_SETTINGS_ROOT = '/settings/project';

const browse = (caps: SettingsNavCapabilities): boolean => caps.canBrowse;
const manage = (caps: SettingsNavCapabilities): boolean => caps.canManage;

/**
 * The registry. Order within a group is the rail order. Routes are PRESERVED
 * (every existing settings URL resolves unchanged inside the area chrome); only
 * `/settings/project` changes meaning (hub → Details landing). Icons mirror
 * `design/projects/settings-area.mock.html` + the app-nav glyphs (Boards reuses
 * `Columns3`; Workflow is the connected-box glyph, NOT GitBranch).
 */
export const PROJECT_SETTINGS_NAV: SettingsNavEntry[] = [
  {
    id: 'details',
    group: 'general',
    href: PROJECT_SETTINGS_ROOT,
    icon: SlidersHorizontal,
    labelKey: 'nav.details',
    access: browse,
    exact: true,
  },
  {
    id: 'members',
    group: 'access',
    href: '/settings/project/members',
    icon: Users,
    labelKey: 'nav.members',
    access: browse,
  },
  {
    id: 'workflow',
    group: 'work',
    href: '/settings/project/workflow',
    icon: Workflow,
    labelKey: 'nav.workflow',
    access: browse,
  },
  {
    id: 'board',
    group: 'work',
    href: '/settings/project/board',
    icon: Columns3,
    labelKey: 'nav.board',
    access: browse,
  },
  {
    id: 'estimation',
    group: 'work',
    href: '/settings/project/estimation',
    icon: Gauge,
    labelKey: 'nav.estimation',
    access: browse,
  },
  {
    id: 'fields',
    group: 'work',
    href: '/settings/project/fields',
    icon: Tag,
    labelKey: 'nav.fields',
    access: browse,
  },
  {
    id: 'components',
    group: 'work',
    href: '/settings/project/components',
    icon: Box,
    labelKey: 'nav.components',
    access: browse,
  },
  {
    id: 'automation',
    group: 'automation',
    href: '/settings/project/automation',
    icon: Bot,
    labelKey: 'nav.rules',
    // Story 6.6 lights up the reserved slot: a real route, ADMIN-ONLY end to end
    // (the verified Jira scope — no member/viewer read-only variant). The entry,
    // the page, and every route gate on the shipped 6.4.3 manage-project
    // predicate, so a non-admin never sees the nav row.
    access: manage,
  },
];

/**
 * The REAL route entries (placeholders excluded) — the set the totality test
 * pairs 1:1 with the on-disk `settings/project/**​/page.tsx` routes.
 */
export const PROJECT_SETTINGS_ROUTES: SettingsNavEntry[] = PROJECT_SETTINGS_NAV.filter(
  (entry) => !entry.placeholder,
);

/** Whether `pathname` is inside the project-settings area. */
export function isProjectSettingsPath(pathname: string): boolean {
  return pathname === PROJECT_SETTINGS_ROOT || pathname.startsWith(`${PROJECT_SETTINGS_ROOT}/`);
}

/** Whether a registry entry is the active route for `pathname`. */
export function isSettingsEntryActive(entry: SettingsNavEntry, pathname: string): boolean {
  if (!entry.href) return false;
  if (entry.exact) return pathname === entry.href;
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
}

/**
 * The entries visible to an actor with the given capabilities. Placeholders and
 * real entries alike gate on their `access` predicate, so a role without browse
 * access sees NOTHING (the whole area filters away — no nav leak).
 */
export function visibleSettingsNav(
  caps: SettingsNavCapabilities,
  entries: SettingsNavEntry[] = PROJECT_SETTINGS_NAV,
): SettingsNavEntry[] {
  return entries.filter((entry) => entry.access(caps));
}

/**
 * Group a flat entry list into the rail's ordered, non-empty groups. Used by the
 * nav (one `SidebarSection` per group) and assertable in isolation.
 */
export function groupSettingsNav(
  entries: SettingsNavEntry[],
): { group: SettingsNavGroup; entries: SettingsNavEntry[] }[] {
  return SETTINGS_NAV_GROUP_ORDER.map((group) => ({
    group,
    entries: entries.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);
}
