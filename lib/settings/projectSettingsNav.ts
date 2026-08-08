import {
  Bot,
  Box,
  Columns3,
  FolderGit2,
  Gauge,
  KeyRound,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Users,
  Workflow,
} from 'lucide-react';
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
  /**
   * Routes reached by DRILLING DOWN from this entry, which deliberately get no
   * rail row of their own (Subtask MOTIR-2263 — the role DETAIL screen). Each
   * must be a strict sub-path of {@link href}: this field declares a nested
   * destination, it is not a second way to register an unrelated page.
   *
   * ⚠️ WHY THIS EXISTS RATHER THAN A WEAKER TOTALITY TEST. The 6.5.2 guard pairs
   * every on-disk `settings/project/**​/page.tsx` 1:1 with a registry entry, so a
   * page that ships with no way to reach it fails the build. A drill-down is the
   * first honest exception — a second `page.tsx` whose door is its PARENT's row,
   * not a row of its own — and the answer is to teach the registry about it, not
   * to relax the assertion until it passes. The guard still pairs the filesystem
   * 1:1 with `PROJECT_SETTINGS_ROUTE_PATHS` (hrefs PLUS declared nested routes),
   * so an undeclared new page still fails exactly as before.
   *
   * `isSettingsEntryActive` already lights the parent row on these, since a
   * non-`exact` entry matches its own sub-paths.
   */
  nestedRoutes?: string[];
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
    id: 'repositories',
    group: 'general',
    href: '/settings/project/repositories',
    icon: FolderGit2,
    labelKey: 'nav.repositories',
    // Story MOTIR-1775 · MOTIR-1939 — the TAKE-IT-OVER room, and the PERMANENT
    // way back to it. The other two doors (the ownership promise's `How moving
    // it works` link, the billing panel's `Move repositories` button) are both
    // moments the user passes through; a `transfer_pending` that sits for days
    // has to be reachable from somewhere that is always there, which is what
    // this row is (design/repository-set §14.4, door 3). Browse-gated like every
    // General entry — a member SEES where the code lives; `projectAccessService`
    // re-gates the takeover write itself.
    access: browse,
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
    id: 'roles',
    group: 'access',
    href: '/settings/project/roles',
    icon: Shield,
    labelKey: 'nav.roles',
    // Story MOTIR-2282 · MOTIR-2263 — what each role in the project can DO.
    // Sits between Members & access (who is on the team) and Code access (who
    // can clone), which is the order `design/projects/design-notes.md` draws:
    // the model, then its two applications.
    //
    // A DRILL-DOWN: the list is the rail row, and `roles/[roleKey]` is reached
    // by activating a row — hence `nestedRoutes` rather than a second entry. The
    // rail keeps this row active on the detail screen (non-`exact` matching).
    //
    // BROWSE-gated like every other Access entry: a member reads what the roles
    // mean, they just cannot author one. Turning that into a permission
    // predicate is MOTIR-2258's job, not this card's.
    access: browse,
    nestedRoutes: ['/settings/project/roles/[roleKey]'],
  },
  {
    id: 'code-access',
    group: 'access',
    href: '/settings/project/code-access',
    icon: KeyRound,
    labelKey: 'nav.codeAccess',
    // Story MOTIR-1775 · MOTIR-1945 — who on the team can clone the project's
    // code. A SIBLING pane rather than a section inside Members & access
    // (design/repository-set §15.3): it is a table with six per-member states,
    // four page states and a second per-repository dimension, and the registry
    // is what gives it a door that cannot silently disappear (the totality
    // test). BROWSE-gated on purpose — unlike the members pane, this one has
    // something a NON-admin can do: connect their own GitHub, which is the one
    // action nobody can take on their behalf (ADR §3 Q3). The write is re-gated
    // in projectRepoAccessService (edit), so the gate stays legible rather than
    // the page vanishing.
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
    id: 'ai-planning',
    group: 'automation',
    href: '/settings/project/ai-planning',
    icon: Sparkles,
    labelKey: 'nav.aiPlanning',
    // Story 7.13 · MOTIR-919 — the AI-planning cadence page (auto-plan, AI
    // sprint planning, planner model + drafted explanations). Registered ABOVE
    // Rules in the Automation group: cadence configures the automatic planner,
    // the same family as automation rules. Browse-gated on purpose — every
    // member SEES the configuration, a non-admin reads it read-only (the design
    // asset's role-state; the write is re-gated in projectAiSettingsService).
    // The entry lights BOTH doors at once — the settings rail row AND the ⌘K
    // deep link (`settings-ai-planning`) — and keeps the route↔registry
    // totality test green.
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

/**
 * EVERY reachable settings destination — each real entry's own `href` plus the
 * drill-down routes it declares in {@link SettingsNavEntry.nestedRoutes}. This is
 * the set the totality test pairs 1:1 with the on-disk
 * `settings/project/**​/page.tsx` routes.
 *
 * The distinction from {@link PROJECT_SETTINGS_ROUTES} is exactly the rail's: a
 * nested route is REACHABLE (so it must be accounted for) but is not a ROW (so it
 * has no icon, no label, and no place in the nav or the command palette).
 */
export const PROJECT_SETTINGS_ROUTE_PATHS: string[] = PROJECT_SETTINGS_ROUTES.flatMap((entry) => [
  entry.href,
  ...(entry.nestedRoutes ?? []),
]);

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
