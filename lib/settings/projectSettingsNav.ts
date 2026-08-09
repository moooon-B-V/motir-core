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
import type { PermissionKey } from '@/lib/permissions/catalog';

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
 * The actor's resolved permission set, as the registry reads it (Story
 * MOTIR-2258 · Subtask MOTIR-2468). `ProjectAccessProvider` carries the array
 * across the server/client boundary; every consumer here wants membership tests,
 * so it is a Set by the time it reaches `visibleSettingsNav`.
 */
export type SettingsNavPermissions = ReadonlySet<PermissionKey>;

/** Build the membership-test form from the DTO's array (or any key list). */
export function toSettingsNavPermissions(
  keys: Iterable<PermissionKey> = [],
): SettingsNavPermissions {
  return new Set<PermissionKey>(keys);
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
  /**
   * The catalog permission this entry's DESTINATION requires — READ OFF that
   * destination's own server gate, never inferred from the entry's name. A rail
   * row that hides on a key the page does not check is a new bug wearing the
   * shape of a fix, and it fails in the worst direction: it hides a room the
   * actor could have used. Every pairing's evidence is in the table above.
   *
   * REQUIRED, so a settings page added later cannot ship an ungated door — the
   * omission is a compile error, not a silently-visible entry.
   */
  permission: PermissionKey;
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
    // VERIFIED: the page resolves `projectAccessService.getManageCapabilities`,
    // whose predicate is `project:administer`, and gates every editable
    // affordance plus the danger zone on it. Details IS the project-level
    // administration that belongs to no domain — rename, key, avatar, archive —
    // so the key its own gate asserts is the right door key. A read-only Details
    // for someone who can change nothing on it is exactly the treatment the
    // 2026-08-08 amendment supersedes.
    permission: 'project:administer',
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
    // this row is (design/repository-set §14.4, door 3).
    //
    // VERIFIED: `projectRepoSetService` and `projectRepoTakeoverService` both
    // assert `repository:manage`; the room's whole purpose is establishing and
    // taking over the set. (Was browse-gated so "a member SEES where the code
    // lives" — retired by the 2026-08-08 amendment, which supersedes read-only
    // views of an administrative surface.)
    permission: 'repository:manage',
  },
  {
    id: 'members',
    group: 'access',
    href: '/settings/project/members',
    icon: Users,
    labelKey: 'nav.members',
    // VERIFIED: `projectMembersService` asserts `member:manage` for the roster
    // writes (and `project:manage_access` for the access level). `member:manage`
    // is the one that makes the page useful at all — the access control is a
    // single card on it.
    permission: 'member:manage',
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
    // MOTIR-2468 retired the browse gate this entry shipped with — a member does
    // NOT read this screen, because the parent story's recipe requires a member
    // to see no settings entries, and "what may I do here" is a question the
    // affordances answer in place.
    //
    // ⚠️ `project:manage_access`, NOT `member:manage` — CHANGED BY MOTIR-2257, and
    // the change is the anticipated half of MOTIR-2468's own reasoning arriving.
    // That entry chose `member:manage` as a JUDGEMENT expressly because *"the page
    // has no write, so it asserts no key of its own"*, while naming this story as
    // the one that would add role AUTHORING here. It has: `Create role`, `Edit`
    // and `Delete` all live on this screen now, and every one of them is gated by
    // `project:manage_access` at the service (`docs/decisions/permission-inventory.md`
    // R51 — governed by the shipped key rather than a new one). So the premise
    // that made `member:manage` a judgement is gone, and the destination now has
    // a key of its own to LOOK UP.
    //
    // The two are identical for all three built-ins, so nothing observable moves
    // today. They come apart for exactly the thing this story invented: a role
    // somebody composed by hand can hold one and not the other — and a rail row
    // that opened onto a screen whose every affordance then refused would be the
    // "looks governed without being it" failure MOTIR-2469's guard exists to stop,
    // wearing the other face.
    permission: 'project:manage_access',
    // MOTIR-2483 adds the two AUTHORING routes beside the drill-down. The static
    // `new` segment resolves ahead of the dynamic sibling; all three keep this
    // row active, so an author never watches the rail lose its place mid-edit.
    nestedRoutes: [
      '/settings/project/roles/[roleKey]',
      '/settings/project/roles/[roleKey]/edit',
      '/settings/project/roles/new',
    ],
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
    // action nobody can take on their behalf (ADR §3 Q3).
    //
    // ⚠️ THAT COMMENT IS RETIRED, DELIBERATELY, AND IT IS THE CLOSEST CALL IN
    // THIS FILE. VERIFIED: `projectRepoAccessService` asserts
    // `repository:manage_access`, and the page's own source says a non-admin
    // "sees the same data, plus the one action that is theirs alone: connecting
    // their own GitHub". But that action does not live here — the page links out
    // to `GITHUB_SETTINGS_PATH` (`/settings/workspace/github`), reached from the
    // bottom nav's own `Git` row, which this story does not touch. So gating the
    // row takes NOTHING a member could do; it takes a read-only view of who else
    // has been invited, which is precisely what the 2026-08-08 amendment
    // supersedes. Keeping it browse-gated would also make the story's headline
    // unreachable: every actor who reaches this shell holds `project:browse`, so
    // one browse-gated entry means the settings AREA door never disappears for
    // anyone. Reversible in one line if the read-only matrix is judged worth it.
    permission: 'repository:manage_access',
  },
  {
    id: 'workflow',
    group: 'work',
    href: '/settings/project/workflow',
    icon: Workflow,
    labelKey: 'nav.workflow',
    // VERIFIED: `workflowsService`'s module-private `assertProjectAdmin` asserts
    // `workflow:manage` (the helper's NAME predates MOTIR-2256's split — reading
    // the body rather than the name is the point, `notes.html` #231).
    permission: 'workflow:manage',
  },
  {
    id: 'board',
    group: 'work',
    href: '/settings/project/board',
    icon: Columns3,
    labelKey: 'nav.board',
    // VERIFIED: `boardsService`'s module-private `assertBoardConfigAdmin` asserts
    // `board:configure` — again a name that predates the split.
    permission: 'board:configure',
  },
  {
    id: 'estimation',
    group: 'work',
    href: '/settings/project/estimation',
    icon: Gauge,
    labelKey: 'nav.estimation',
    // VERIFIED: `estimationService.assertEstimationAdmin` asserts
    // `estimation:manage`.
    permission: 'estimation:manage',
  },
  {
    id: 'fields',
    group: 'work',
    href: '/settings/project/fields',
    icon: Tag,
    labelKey: 'nav.fields',
    // VERIFIED: `customFieldsService`'s module-private `assertCanManage` asserts
    // `field:manage`.
    permission: 'field:manage',
  },
  {
    id: 'components',
    group: 'work',
    href: '/settings/project/components',
    icon: Box,
    labelKey: 'nav.components',
    // VERIFIED: `componentsService`'s module-private `assertCanManage` asserts
    // `component:manage`.
    permission: 'component:manage',
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
    //
    // VERIFIED: `projectAiSettingsService.updateAiSettings` asserts
    // `ai:configure`. (Was browse-gated so "a non-admin reads it read-only" —
    // retired by the 2026-08-08 amendment. `ai:plan`, which a member DOES hold,
    // gates running the planner, not configuring it.)
    permission: 'ai:configure',
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
    //
    // VERIFIED, and the only entry already correct before this card: the PAGE
    // itself reads `getPermissions` and returns the no-access state unless
    // `held.has('automation:manage')`, and `automationRulesService` asserts the
    // same key. The row now names what the page already checks.
    permission: 'automation:manage',
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
 * The entries visible to an actor holding `held`. Placeholders and real entries
 * alike gate on their declared `permission`, so an actor holding no
 * administrative key sees NOTHING — the whole area filters away, no nav leak.
 *
 * ⚠️ HIDING IS PRESENTATION, NEVER ENFORCEMENT. A row this drops is still
 * reachable by URL; what refuses it is the destination's own guard (MOTIR-2469)
 * and, behind that, the service gate whose key the entry names. Do not read a
 * filtered rail as a security boundary.
 */
export function visibleSettingsNav(
  held: SettingsNavPermissions,
  entries: SettingsNavEntry[] = PROJECT_SETTINGS_NAV,
): SettingsNavEntry[] {
  return entries.filter((entry) => held.has(entry.permission));
}

/**
 * Whether the project-settings AREA has anything behind it for this actor — the
 * predicate the shell's **Project settings** door gates on (design panel 1).
 *
 * A per-entry filter does not cover this on its own: filtering all twelve
 * entries away leaves a perfectly valid EMPTY rail behind a perfectly valid
 * link, which is a door onto a corridor. Expressed here, beside the filter it
 * quantifies over, so the door and the rows can never disagree about what the
 * area contains.
 */
export function hasVisibleSettingsArea(held: SettingsNavPermissions): boolean {
  return PROJECT_SETTINGS_NAV.some((entry) => held.has(entry.permission));
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
