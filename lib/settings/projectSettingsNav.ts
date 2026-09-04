import {
  Bot,
  Box,
  Columns3,
  FolderGit2,
  Gauge,
  Globe,
  KeyRound,
  Link2,
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
// A later admin story mounts its page by ADDING an entry here — no layout change.
// The Automation slot below was the worked example of the OTHER route in: a slot
// reserved ahead of its page for Story 6.6, drawn disabled until 6.6.5 lit it up.
// That reservation mechanism is RETIRED (MOTIR-4324) — with Automation live the
// reserved set was empty, leaving the flag, its rail rendering and its filter
// unreachable from the product. Reserving a slot again is a deliberate
// re-introduction with its first real user, not a field to set. The asset of
// record is
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

/**
 * What this DEPLOYMENT has, as distinct from what this ACTOR holds (Story
 * MOTIR-3875 · MOTIR-4243). The registry is static and the permission set is
 * per-actor; a capability that a whole BUILD does not have is neither, so the
 * caller supplies it.
 *
 * Today it carries one fact, deliberately typed as a named field rather than a
 * bare boolean so the next capability joins it without changing a signature.
 */
export interface SettingsNavAvailability {
  /**
   * Whether public projects exist on this build — `isCloud()`, resolved on the
   * SERVER (`app/(authed)/layout.tsx` already resolves it for the header slot)
   * and threaded to the client surfaces that filter the registry.
   */
  publicProjectsAvailable: boolean;
}

/**
 * The DEFAULT, and it fails CLOSED on purpose: a caller that forgets to thread
 * the deployment fact drops every {@link SettingsNavEntry.cloudOnly} row rather
 * than offering one. The opposite default would put a rail row and a ⌘K action
 * on a self-hosted build in front of a route that answers 404 — the "door onto a
 * corridor" {@link hasVisibleSettingsArea} exists to refuse, one row down.
 *
 * The same shape as `SidebarNav`'s own `workspaceTierRevealed` prop, and for the
 * same reason.
 */
const NO_CLOUD_CAPABILITIES: SettingsNavAvailability = { publicProjectsAvailable: false };

/** Whether `entry` exists at all on a deployment with these capabilities. */
function isEntryAvailable(entry: SettingsNavEntry, available: SettingsNavAvailability): boolean {
  return !entry.cloudOnly || available.publicProjectsAvailable;
}

export interface SettingsNavEntry {
  /** Stable id — also the command-palette action id (`settings-<id>`). */
  id: string;
  group: SettingsNavGroup;
  /** The preserved settings route this entry navigates to. Every entry is a real route. */
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
   * This room exists ONLY on a cloud build (`isCloud()`), so the row is ABSENT
   * off-cloud rather than merely gated — Story MOTIR-3908's ruling that
   * public projects are not a hidden feature on a self-hosted Motir but an
   * ABSENT one (`lib/publicProjects/cloudGate.ts`).
   *
   * ⚠️ IT IS A SECOND AXIS, NOT A SECOND PERMISSION. {@link permission} answers
   * *may THIS ACTOR use the room*; this answers *does the room exist on THIS
   * DEPLOYMENT at all*. They compose — a cloud-only row still needs its key —
   * and they fail differently: a permission a reader lacks hides a room that is
   * there, while an absent capability has nothing behind the door. Keeping them
   * apart is what lets the destination answer `notFound()` off-cloud (the
   * billing page's precedent) rather than the refusal state, which would say
   * *this exists and you may not see it* about a build where it does not exist.
   *
   * The registry is static, so the DEPLOYMENT fact has to be supplied by the
   * caller: {@link visibleSettingsNav} and {@link hasVisibleSettingsArea} take a
   * {@link SettingsNavAvailability} and it DEFAULTS CLOSED, so a surface that
   * forgets to thread it drops the row rather than offering a door onto a
   * corridor. The route ↔ registry totality test pairs the route with this entry
   * regardless of the flag: the page exists in the tree either way.
   */
  cloudOnly?: true;
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
    id: 'public-page',
    group: 'access',
    href: '/settings/project/public',
    icon: Globe,
    labelKey: 'nav.publicPage',
    // Story MOTIR-3875 · MOTIR-4243, drawn by MOTIR-4205
    // (`design/projects/public-page.mock.html` Panel A frame ①,
    // `design/projects/design-notes.md` § *The entrance — three doors*). Where a
    // project admin edits the tagline, tags and README that `motir.co/p/<key>`
    // renders. It sits DIRECTLY UNDER Members & access: that room owns the
    // public concerns (the make-public control, the share link, the Hero &
    // overview door) and is the row a reader arrives from.
    //
    // `Globe`, and NOT `Megaphone` — that glyph is the *Building in public*
    // STATUS badge in the top bar, and a room and a status must not share a mark.
    //
    // VERIFIED: the room's write is `projectsService.setPublicOverview`, which
    // asserts `projectAccessService.assertCanManage` — an alias for
    // `assertPermission(…, 'project:administer')` (`projectAccessService.ts`).
    // The key-routed door the room saves through
    // (`publicProjectsService.setPublicOverview`, `PATCH
    // /api/projects/{key}/public-overview`) refuses a non-admin ahead of it and
    // re-runs the same assertion inside the write transaction. Read off the
    // destination's own gate, per this file's rule. No read-only view: the
    // 2026-08-08 amendment supersedes read-only administrative rooms.
    permission: 'project:administer',
    // CLOUD-ONLY (MOTIR-3908). Off-cloud there are no public projects, so this
    // is a room with nothing behind it — the row is absent and the page 404s.
    cloudOnly: true,
  },
  {
    id: 'public-address',
    group: 'access',
    href: '/settings/project/public-address',
    icon: Link2,
    labelKey: 'nav.publicAddress',
    // Story MOTIR-3878 · MOTIR-4221, drawn by MOTIR-4211
    // (`design/projects/public-address.mock.html` panels 0–2, 8, 9 ·
    // `design/projects/design-notes.md` § *Public address*). Where a workspace
    // claims its subdomain and a project connects a domain the customer owns.
    //
    // ⚠️ THE ORDER IS THE ASSET'S, NOT THE CARD'S, AND THAT IS A RUNG-2 READING
    // BEATING A RUNG-3 ONE. MOTIR-4221 says the row goes "between Members &
    // access and Roles"; that slot was taken by *Public page* (MOTIR-4243) while
    // this story was in flight. Two public rooms either side of one door is the
    // coherent shape, so the asset draws — and this is —
    //   Members & access → Public page → Public address → Roles → Code access
    // The card's intent (the `access` group, adjacent to Members & access) is
    // honoured; only the neighbour changed.
    //
    // `Link2`, and NOT `Globe` — that glyph is *Public page*, one row up. Two
    // rooms in the same group sharing a mark is exactly what MOTIR-4243's own
    // note refuses between a room and a status badge, applied between two rooms.
    //
    // VERIFIED, and this key is the one thing the design asset deliberately did
    // NOT decide (its planning flag 1: "MOTIR-4221's to READ OFF its own service
    // gate"). The room's writes are `customDomainService.{add,verify,remove,
    // makePrimary,clearPrimary}`, every one of which asserts
    // `assertPermission(…, 'project:manage_access')`; its list asserts
    // `project:browse`. So the key the room's WRITES assert is this one, read off
    // the destination rather than inferred from the row's name.
    //
    // ⚠️ AND `project:browse` WOULD HAVE BEEN THE WRONG READING, though the
    // subdomain half of the room is readable by any workspace member. No settings
    // entry is gated on it, so adding the first one would hand every project
    // VIEWER a settings door — the 2026-08-08 amendment's "no read-only
    // administrative rooms" refuses that, and the asset's panel 8 says so in
    // terms: a member who can read but not administer never reaches this row.
    //
    // THE READ-ONLY ARM IS THE OTHER CASE, and it is real rather than defensive:
    // the subdomain's own writes are gated on the WORKSPACE role (owner/admin,
    // `publicSubdomainService`), which is a different axis from the project
    // permission above. A project admin who is a workspace *member* holds the
    // door key and not the write key, so the pane renders the address with every
    // control ABSENT (panel 8). `roleMayManageAddress` is exported from that
    // service so the rule has one home.
    permission: 'project:manage_access',
    // CLOUD-ONLY (ADR §11): a self-hosted build has no public projects, so this
    // is a room with nothing behind it. The flag is MOTIR-4243's — this entry
    // USES it and does not re-introduce it, which the asset flagged as a build
    // dependency precisely so two cards could not add one field twice.
    cloudOnly: true,
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
    // MOTIR-3332 / MOTIR-3338 add the LESSON LIBRARY as a DRILL-DOWN, the same
    // shape `roles` uses: the AI-planning page carries a read-only card that
    // previews what the planner has learned and links here; the library itself
    // needs a page that can be as long as it needs, and a settings page with a
    // Save footer is not one. `nestedRoutes` rather than a second entry, so no
    // new Automation row competes with the settings the library belongs to and
    // the rail keeps THIS row active on both screens (non-`exact` matching).
    //
    // ⚠️ The entry's key stays `ai:configure` and the destinations assert
    // `lesson:view` ON TOP of it, in `projectLessonsService` — before any call
    // to motir-ai. The two are deliberately not the same question: `ai:configure`
    // is "may you open the AI-planning area", `lesson:view` is "may you read what
    // this project taught its planner". Both sit at `admin` today, so nothing
    // observable moves; they come apart for a custom role composed by hand,
    // which is the case MOTIR-3336 split the keys to make expressible.
    nestedRoutes: [
      '/settings/project/ai-planning/lessons',
      '/settings/project/ai-planning/lessons/[lessonId]',
    ],
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
 * The route entries — the set the totality test pairs 1:1 with the on-disk
 * `settings/project/**​/page.tsx` routes.
 *
 * This USED to be `PROJECT_SETTINGS_NAV` minus the reserved-slot entries, and it
 * is now the whole registry: MOTIR-4324 retired the reservation mechanism, so
 * every entry is a real route by construction. The name is kept because it is
 * what its call sites read it AS — "the destinations", the question the totality
 * test and the palette are asking — and because a route/row distinction
 * returning is a filter to restore here rather than a symbol to re-thread. The
 * live row/route distinction is {@link PROJECT_SETTINGS_ROUTE_PATHS} below, which
 * is a different one: nested drill-down routes are reachable but are not rows.
 */
export const PROJECT_SETTINGS_ROUTES: SettingsNavEntry[] = PROJECT_SETTINGS_NAV;

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
 *
 * `available` is the second axis (MOTIR-4243): a {@link SettingsNavEntry.cloudOnly}
 * row is dropped on a build that does not have the capability, whatever the
 * actor holds. It DEFAULTS CLOSED — see {@link SettingsNavAvailability}.
 */
export function visibleSettingsNav(
  held: SettingsNavPermissions,
  entries: SettingsNavEntry[] = PROJECT_SETTINGS_NAV,
  available: SettingsNavAvailability = NO_CLOUD_CAPABILITIES,
): SettingsNavEntry[] {
  return entries.filter(
    (entry) => isEntryAvailable(entry, available) && held.has(entry.permission),
  );
}

/**
 * Whether the project-settings AREA has anything behind it for this actor — the
 * predicate the shell's **Project settings** door gates on (design panel 1).
 *
 * A per-entry filter does not cover this on its own: filtering every entry away
 * leaves a perfectly valid EMPTY rail behind a perfectly valid link, which is a
 * door onto a corridor. Expressed here, beside the filter it quantifies over, so
 * the door and the rows can never disagree about what the area contains — which
 * is why it takes the SAME `available` argument (MOTIR-4243) rather than
 * quantifying over a rail the caller is not going to render.
 */
export function hasVisibleSettingsArea(
  held: SettingsNavPermissions,
  available: SettingsNavAvailability = NO_CLOUD_CAPABILITIES,
): boolean {
  return PROJECT_SETTINGS_NAV.some(
    (entry) => isEntryAvailable(entry, available) && held.has(entry.permission),
  );
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
