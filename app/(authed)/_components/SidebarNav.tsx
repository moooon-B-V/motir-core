'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Activity,
  BarChart3,
  BookOpen,
  CircleDot,
  CirclePlay,
  Columns3,
  GitBranch,
  History,
  House,
  Inbox,
  LayoutDashboard,
  LayoutList,
  ListChecks,
  Map,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Sidebar, type SidebarItem, type SidebarSection } from '@/components/ui/Sidebar';
import { ONBOARDING_RESUME_PATH } from '@/lib/onboarding/resumeVisibility';
import { useOnboardingResume } from './OnboardingResumeProvider';
import { SidebarToggle } from '@/components/ui/SidebarToggle';
import { useSidebarCollapsed } from '@/lib/hooks/useSidebarCollapsed';
import type { ProjectDTO } from '@/lib/dto/projects';
import {
  groupSettingsNav,
  hasVisibleSettingsArea,
  isProjectSettingsPath,
  isSettingsEntryActive,
  PROJECT_SETTINGS_ROOT,
  toSettingsNavPermissions,
  visibleSettingsNav,
} from '@/lib/settings/projectSettingsNav';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { canOfferNavDestination } from '@/lib/settings/projectNavAccess';
import {
  ACCOUNT_SETTINGS_NAV,
  groupAccountSettingsNav,
  isAccountSettingsEntryActive,
  isAccountSettingsPath,
} from '@/lib/settings/accountSettingsNav';
import { SettingsSidebarHeader } from './SettingsSidebarHeader';
import { AccountSidebarHeader } from './AccountSidebarHeader';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The signed-in navigation rail. Composes the 1.5.2 Sidebar primitive with the
// route-aware nav sections — and, in the settings and account AREAS, that
// area's own header. The DEFAULT area has no header: the project context it
// used to hold is the top bar's context path since MOTIR-2556. Active
// detection is client-side (usePathname), which is why the whole rail is a
// client component rather than the layout building <Sidebar sections={…} />
// directly — section `active` flags can't be computed in the server layout.
//
// Section shape (PRODECT_FINDINGS #29):
//   - active project (archived or not) → primary [Dashboard, Issues, Boards,
//     Reports] + bottom [Settings → /settings/project, Docs]. The project-
//     scoped nav stays visible even when archived (#29.2); the stub pages
//     render the "this project is archived" empty state themselves.
//   - no project (#29.1) → only the bottom section, with Settings deep-
//     linking to the WORKSPACE settings (there's no project to configure).
//
// #29's THIRD state — the create-first CTA — is no longer here: it moved with
// the project control into the bar's project tier (`ProjectTier`), which is
// also where the archived pill and the switcher went.
//
// Settings AREA swap (Story 6.5 · Subtask 6.5.2): when the route is inside the
// project-settings area (`/settings/project*`) and a project is active, the rail
// REPLACES the project nav with the grouped settings nav rendered FROM the
// `projectSettingsNav` registry (filtered by the actor's permission set) and
// swaps the header for the SettingsSidebarHeader (back-to-project + identity).
// This is the design's "same rail" decision — one rail, no double chrome — which
// the App Router forces into THIS component (the rail lives here, not in a
// nested layout under <main>). The drawer variant inherits the swap for free.
//
// Two variants: `rail` (the persistent desktop rail, follows the shared
// collapse store, carries the footer collapse toggle) and `drawer` (the
// <md off-canvas body, always expanded, no footer — the drawer chrome owns
// its own close affordance).

export interface SidebarNavProps {
  activeProject: ProjectDTO | null;
  variant?: 'rail' | 'drawer';
  /**
   * The actor's resolved permission keys for the active project (Subtask
   * MOTIR-2468), resolved once in the (authed) layout. Drives BOTH the
   * settings-nav registry's per-entry filter when the rail is in the
   * project-settings area AND whether the bottom nav renders the Project
   * settings door at all. Omitted when there is no active project; an absent
   * value defaults CLOSED, so a missing prop never leaks an entry or a door.
   */
  settingsPermissions?: readonly PermissionKey[];
  /**
   * The signed-in user's identity (Subtask 7.8.12) — drives the account-settings
   * area rail header (initial avatar + name + email) when the rail is inside the
   * `/settings/account*` area. Resolved once in the (authed) layout from the
   * session (the same `{ name, email }` the TopNav user menu shows).
   */
  user: { name: string; email: string };
  /**
   * The active org reveals the WORKSPACE tier (≥2 workspaces the viewer belongs
   * to — `lib/workspaces/tierDisclosure.ts`). Retargets the no-project settings
   * door: `/settings/workspace` above the threshold, `/settings/organization`
   * at or below it, where that page hosts the folded-in workspace sections
   * (`docs/decisions/organization-tier.md` §6d).
   *
   * The Job runs and Git rows below are NOT gated on this and must not be: they
   * are workspace-SCOPED but not workspace-NAMED, and §6 reveals a tier rather
   * than relocating every page beneath it.
   *
   * Defaults FALSE — an omitted prop points the door at the home that exists at
   * every count, so a caller that forgets to thread it fails closed.
   */
  workspaceTierRevealed?: boolean;
}

function isActive(pathname: string, match: string): boolean {
  return pathname === match || pathname.startsWith(`${match}/`);
}

/** The Automation slot's "Soon" chip — a yellow-tint badge, AA-safe (hue in the
 *  background, `--el-text-strong` ink; finding #35). State is conveyed by the
 *  text, not colour alone. */
function SoonChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-yellow) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-[10px] font-semibold uppercase tracking-wide text-(--el-text-strong)">
      {label}
    </span>
  );
}

/** The "Resume onboarding" row's in-progress indicator (MOTIR-1533). A compact
 *  accent dot — a text chip would truncate the 17-char label at the 240px rail
 *  width — with a visually-hidden label so the state reaches assistive tech by
 *  text, not colour alone (finding #35). */
function ResumeInProgressBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center">
      <span className="sr-only">{label}</span>
      <span aria-hidden className="h-2 w-2 rounded-full bg-(--el-accent)" />
    </span>
  );
}

export function SidebarNav({
  activeProject,
  variant = 'rail',
  settingsPermissions,
  user,
  workspaceTierRevealed = false,
}: SidebarNavProps) {
  const t = useTranslations('shell');
  const ts = useTranslations('settings');
  const pathname = usePathname();
  const [storeCollapsed] = useSidebarCollapsed();
  // The "Resume onboarding" signal (MOTIR-1533) — read unconditionally (before
  // the settings/account early returns) to respect the rules of hooks.
  const canResume = useOnboardingResume();
  const isDrawer = variant === 'drawer';
  // The drawer always renders expanded; the rail follows the shared store.
  const collapsed = isDrawer ? false : storeCollapsed;

  const hasProject = Boolean(activeProject);
  // The actor's keys in membership-test form, used by BOTH the settings-area
  // rail below and the bottom nav's Project settings door. Built once, before
  // the two early returns, so the door and the rows it opens onto can never
  // disagree about what the area contains.
  const held = toSettingsNavPermissions(settingsPermissions);

  // Account-settings AREA (Subtask 7.8.12): swap the project nav for the
  // registry-driven account-settings nav. Unlike the project area this does NOT
  // gate on an active project — account settings are personal, reachable with no
  // project selected — and the header shows the USER, not the project.
  if (isAccountSettingsPath(pathname)) {
    const accountSections: SidebarSection[] = groupAccountSettingsNav(ACCOUNT_SETTINGS_NAV).map(
      ({ group, entries }) => ({
        id: `account-settings-${group}`,
        label: ts(`account.nav.group.${group}`),
        items: entries.map((entry) => ({
          icon: <entry.icon />,
          label: ts(`account.nav.${entry.labelKey}`),
          // Placeholder rows carry an empty href; SidebarItem ignores it for a
          // disabled row (a non-interactive span) and the React key falls back to
          // the label, so the empty href is correct (no collision).
          href: entry.href,
          active: isAccountSettingsEntryActive(entry, pathname),
          disabled: entry.placeholder,
          badge: entry.placeholder ? <SoonChip label={ts('account.nav.soon')} /> : undefined,
        })),
      }),
    );
    return (
      <Sidebar
        aria-label={ts('account.eyebrow')}
        header={<AccountSidebarHeader user={user} collapsed={collapsed} />}
        sections={accountSections}
        footer={isDrawer ? undefined : <SidebarToggle variant="footer" />}
        collapsed={isDrawer ? false : undefined}
      />
    );
  }

  // Settings AREA: swap the project nav for the registry-driven settings nav.
  if (activeProject && isProjectSettingsPath(pathname)) {
    const settingsSections: SidebarSection[] = groupSettingsNav(visibleSettingsNav(held)).map(
      ({ group, entries }) => ({
        id: `settings-${group}`,
        label: ts(`nav.group.${group}`),
        items: entries.map((entry) => ({
          icon: <entry.icon />,
          label: ts(entry.labelKey),
          href: entry.href,
          active: isSettingsEntryActive(entry, pathname),
          disabled: entry.placeholder,
          badge: entry.placeholder ? <SoonChip label={ts('nav.soon')} /> : undefined,
        })),
      }),
    );
    return (
      <Sidebar
        aria-label={ts('nav.eyebrow')}
        header={<SettingsSidebarHeader activeProject={activeProject} collapsed={collapsed} />}
        sections={settingsSections}
        footer={isDrawer ? undefined : <SidebarToggle variant="footer" />}
        collapsed={isDrawer ? false : undefined}
      />
    );
  }

  const sections: SidebarSection[] = [];

  if (hasProject) {
    const primaryItems: SidebarItem[] = [
      {
        // The signed-in landing surface (Story MOTIR-2649 · Subtask
        // MOTIR-2654, design/home/ Panel A) — the FIRST primary entry, above
        // Dashboard, because it is where signing in now lands and where a
        // reader goes to ask "what is waiting on me". `/dashboard` keeps its
        // route AND the row below: nothing is re-homed.
        //
        // ⚠️ PROJECT-scoped, like every row under it (MOTIR-2761) — which is
        // why this section is the ONLY place it is rendered. It used to be
        // workspace-scoped and carried a duplicate row in the no-project block
        // below; both are gone.
        icon: <House />,
        label: t('nav.home'),
        href: AUTHED_LANDING_PATH,
        active: isActive(pathname, AUTHED_LANDING_PATH),
      },
      {
        icon: <LayoutDashboard />,
        label: t('nav.dashboard'),
        href: '/dashboard',
        active: isActive(pathname, '/dashboard'),
      },
      {
        icon: <CircleDot />,
        label: t('nav.issues'),
        href: '/items',
        active: isActive(pathname, '/items'),
      },
      {
        // The AI dispatch surface (Subtask 7.0.6) — sits BETWEEN Issues and
        // Boards. `CirclePlay` (run/dispatch) is the 7.0.1-locked glyph (Zap
        // is taken by the epic issue type). No count badge: the readiness set
        // is a computed predicate that scanned on EVERY authed route, so the
        // count is resolved only when you land on /ready (MOTIR-1284).
        icon: <CirclePlay />,
        label: t('nav.ready'),
        href: '/ready',
        active: isActive(pathname, '/ready'),
      },
      {
        icon: <Columns3 />,
        label: t('nav.boards'),
        href: '/boards',
        active: isActive(pathname, '/boards'),
      },
      {
        // The persistent project Roadmap view (Subtask 7.20.5 / MOTIR-1011) —
        // its own primary nav entry (the access path, per the ai-planning
        // design §5 "drawn beside the other project nav surfaces"; NOT a
        // Board↔Roadmap toggle). The folded-map glyph matches the roadmap
        // design's view icon. Sits after Boards, as a sibling work view.
        icon: <Map />,
        label: t('nav.roadmap'),
        href: '/roadmap',
        active: isActive(pathname, '/roadmap'),
      },
      {
        // The AI Plans index (Story 7.21 · Subtask 7.21.1 / MOTIR-1338) — the
        // list of every AI-generated plan (proposal bundle) for the project,
        // from which the user reviews + approves/declines one. The access path
        // per the ai-planning design §5 (a planning surface reached from a
        // left-nav entry beside the other project nav surfaces). `Sparkles` is
        // the Motir-AI mark the shipped `PlanWithAILauncher` already uses. Sits
        // beside Roadmap, the adjacent planning surface.
        icon: <Sparkles />,
        label: t('nav.plans'),
        href: '/plans',
        active: isActive(pathname, '/plans'),
      },
      {
        // The backlog / sprint-planning surface (Subtask 4.2.3) — between
        // Boards and Reports, with the layout-list glyph (4.2.1 design notes).
        icon: <LayoutList />,
        label: t('nav.backlog'),
        href: '/backlog',
        active: isActive(pathname, '/backlog'),
      },
      {
        // The incoming-work front door (Story 6.11 · Subtask 6.11.6) — the
        // triage inbox of un-acted-on bug reports & feature requests. `Inbox`
        // is the 6.11 design-notes glyph; sits after Backlog.
        icon: <Inbox />,
        label: t('nav.triage'),
        href: '/triage',
        active: isActive(pathname, '/triage'),
      },
      {
        icon: <BarChart3 />,
        label: t('nav.reports'),
        href: '/reports',
        active: isActive(pathname, '/reports'),
      },
      {
        // Code health (7.14.5) — the code-health audit + coding-convention
        // review/approve surface; sits after Reports (a top-level project page).
        icon: <Activity />,
        label: t('nav.codeHealth'),
        href: '/code-health',
        active: isActive(pathname, '/code-health'),
      },
    ];
    // The labeled "Resume onboarding" re-entry door (MOTIR-1533; design
    // MOTIR-1548) leads the primary nav when the active project has an
    // in-progress onboarding — the highest-priority next action. It routes to
    // /onboarding, which resumes at the real persisted step (MOTIR-1487).
    if (canResume) {
      primaryItems.unshift({
        icon: <History />,
        label: t('nav.resumeOnboarding'),
        href: ONBOARDING_RESUME_PATH,
        emphasis: true,
        badge: <ResumeInProgressBadge label={t('nav.resumeOnboardingInProgress')} />,
      });
    }
    // MOTIR-2471 — the same gate the ⌘K navigations use, from the same map, so
    // the two surfaces cannot drift. A row whose destination refuses the actor
    // outright is not rendered and the rows below close up; nothing marks the
    // gap (design panel 4). The Resume-onboarding row above carries its own
    // `canResume` gate and is deliberately not in the map — it is a state, not a
    // permission.
    const offered = primaryItems.filter(
      (item) => item.href === ONBOARDING_RESUME_PATH || canOfferNavDestination(item.href, held),
    );
    sections.push({ id: 'primary', items: offered });
  }

  // NO ACTIVE PROJECT — and no primary section at all. There WAS a second,
  // duplicate Home row here (Subtask MOTIR-2654), justified by "Home is
  // workspace-scoped: it works with no project" — which is precisely the
  // property MOTIR-2761 removed. Once `/home` needs a project, a row offering it
  // to a reader who has none is a row promising a room the product cannot open,
  // so Home joins every other primary entry in being correctly absent and the
  // rail keeps only its bottom section. `/home` stays reachable by URL and
  // renders the create-first door there; nothing redirects
  // (`docs/decisions/home-scope.md` §2.1–2.2).
  //
  // The row was also the tell, not merely a consequence: a special case invented
  // to make a new surface fit its slot is a signal about the slot
  // (`notes.html` #263 / MOTIR-2762). Curing the mismatch retires it.

  // THE AREA DOOR (Subtask MOTIR-2468, design panel 1). With an active project
  // the Settings row deep-links into the project-settings area — so it renders
  // only when that area has something behind it for this actor. An actor whose
  // every entry filters away gets NO row: the rows below simply close up and the
  // footer is one shorter, with nothing marking the gap (no disabled row, no
  // tooltip — an entry point is a promise about a room, and a disabled row is a
  // promise the product then refuses).
  //
  // With NO active project the row still targets workspace settings and is
  // ALWAYS rendered: workspace settings are governed by the workspace role,
  // which this epic does not change, and `held` is empty in that state anyway —
  // gating on it would hide a door this story has no business touching.
  const showSettingsDoor = hasProject ? hasVisibleSettingsArea(held) : true;

  sections.push({
    id: 'bottom',
    items: [
      ...(showSettingsDoor
        ? [
            {
              icon: <Settings />,
              label: t('nav.settings'),
              // Deep-link to project settings when a project is active;
              // otherwise there's nothing project-scoped to configure, so go to
              // the settings HOME — which one depends on progressive disclosure
              // (MOTIR-3502 · organization-tier §6d). Below the reveal threshold
              // the workspace tier is hidden and its sections are folded into
              // `/settings/organization`, so the door points there. Re-pointed,
              // not removed: this is the rail's only settings entry with no
              // active project, and a settings home exists at every count.
              href: hasProject
                ? PROJECT_SETTINGS_ROOT
                : workspaceTierRevealed
                  ? '/settings/workspace'
                  : '/settings/organization',
              // Stay un-highlighted when a more-specific workspace-settings
              // sub-link (Job runs / GitHub) is the active route, so only one
              // row reads current.
              active:
                isActive(pathname, '/settings') &&
                !isActive(pathname, '/settings/workspace/security') &&
                !isActive(pathname, '/settings/workspace/jobs') &&
                !isActive(pathname, '/settings/workspace/github') &&
                !isActive(pathname, '/settings/workspace/gitlab'),
            },
          ]
        : []),
      // Workspace Security (Story MOTIR-1215 · MOTIR-3647) — the require-2FA
      // policy for this workspace.
      //
      // ⚠️ GATED ON THE TIER REVEAL, WHICH THE TWO ROWS BELOW ARE NOT — and the
      // difference is the rule, not an inconsistency. Job runs and Git are
      // workspace-SCOPED but not workspace-NAMED, so §6 leaves them alone. This
      // pane is workspace-NAMED and `notFound()`s below the threshold, so a row
      // here would point at a 404. Below it the control is reached by scrolling
      // `/settings/organization`, where `WorkspaceFoldInSection` hosts it.
      ...(workspaceTierRevealed
        ? [
            {
              icon: <ShieldCheck />,
              label: t('nav.security'),
              href: '/settings/workspace/security',
              active: isActive(pathname, '/settings/workspace/security'),
            },
          ]
        : []),
      {
        // Operator surface (Subtask 1.6.5) — the workspace's background-job runs
        // + dead-letter queue. A workspace-scoped settings sub-page.
        icon: <ListChecks />,
        label: t('nav.jobRuns'),
        href: '/settings/workspace/jobs',
        active: isActive(pathname, '/settings/workspace/jobs'),
      },
      {
        // Git integration settings (Story 7.10 GitHub + 7.23 GitLab · MOTIR-1478)
        // — the SHARED connect-settings surface: connect the workspace to GitHub
        // or GitLab (a provider Segmented swaps the variant) and see the connected
        // repos/projects. ONE "Git" row (git-branch glyph) — GitLab does NOT get a
        // second row; the row lands on the GitHub variant by default, and is
        // active on both provider routes. A workspace-scoped settings sub-page
        // reached the same way Job runs is (a bottom-nav deep link — there is no
        // separate workspace-settings rail).
        icon: <GitBranch />,
        label: t('nav.git'),
        href: '/settings/workspace/github',
        active:
          isActive(pathname, '/settings/workspace/github') ||
          isActive(pathname, '/settings/workspace/gitlab'),
      },
      {
        // The documentation area's front door (MOTIR-2570) — `/docs`, not
        // `/docs/api`: the index IS the area, and pointing the rail at the REST
        // reference is the defect the index story exists to fix. This row used
        // to escape to the GitHub README on the premise that there was no
        // in-app docs route; there has been one since `/docs/api` shipped.
        //
        // No `active` arm, deliberately: `/docs` renders in the `(public)`
        // route group OUTSIDE this shell, so the rail is never on screen there
        // and `pathname` can never match.
        icon: <BookOpen />,
        label: t('nav.docs'),
        href: '/docs',
      },
    ],
  });

  return (
    <Sidebar
      // NO header in the default area (MOTIR-2556 · design/shell § *The rail
      // head, after the project leaves*). The rail answers "where inside this
      // project can I go"; its head was answering "which project am I in",
      // which is the top bar's context path now — and is why this slot needed
      // three states (a create-first card, an archived pill, a collapsed
      // avatar) that no rail ROW needs. The settings and account areas keep
      // their own headers above; only the project one left.
      sections={sections}
      footer={isDrawer ? undefined : <SidebarToggle variant="footer" />}
      collapsed={isDrawer ? false : undefined}
    />
  );
}
