'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  BookOpen,
  CircleDot,
  CirclePlay,
  Columns3,
  Inbox,
  LayoutDashboard,
  LayoutList,
  ListChecks,
  Map,
  Settings,
  Sparkles,
} from 'lucide-react';
import { Sidebar, type SidebarSection } from '@/components/ui/Sidebar';
import { SidebarToggle } from '@/components/ui/SidebarToggle';
import { useSidebarCollapsed } from '@/lib/hooks/useSidebarCollapsed';
import type { ProjectDTO } from '@/lib/dto/projects';
import {
  groupSettingsNav,
  isProjectSettingsPath,
  isSettingsEntryActive,
  visibleSettingsNav,
  type SettingsNavCapabilities,
} from '@/lib/settings/projectSettingsNav';
import {
  ACCOUNT_SETTINGS_NAV,
  groupAccountSettingsNav,
  isAccountSettingsEntryActive,
  isAccountSettingsPath,
} from '@/lib/settings/accountSettingsNav';
import { SidebarHeader } from './SidebarHeader';
import { SettingsSidebarHeader } from './SettingsSidebarHeader';
import { AccountSidebarHeader } from './AccountSidebarHeader';

// The signed-in navigation rail. Composes the 1.5.2 Sidebar primitive with
// a SidebarHeader (project context) and the route-aware nav sections. Active
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
// Settings AREA swap (Story 6.5 · Subtask 6.5.2): when the route is inside the
// project-settings area (`/settings/project*`) and a project is active, the rail
// REPLACES the project nav with the grouped settings nav rendered FROM the
// `projectSettingsNav` registry (filtered by the actor's `settingsAccess`) and
// swaps the header for the SettingsSidebarHeader (back-to-project + identity).
// This is the design's "same rail" decision — one rail, no double chrome — which
// the App Router forces into THIS component (the rail lives here, not in a
// nested layout under <main>). The drawer variant inherits the swap for free.
//
// Two variants: `rail` (the persistent desktop rail, follows the shared
// collapse store, carries the footer collapse toggle) and `drawer` (the
// <md off-canvas body, always expanded, no footer — the drawer chrome owns
// its own close affordance).

// Docs is an external link (no in-app docs route yet); points at the repo.
const DOCS_URL = 'https://github.com/moooon-B-V/motir-core#readme';

export interface SidebarNavProps {
  activeProject: ProjectDTO | null;
  projects: ProjectDTO[];
  variant?: 'rail' | 'drawer';
  /** Whether the AI planning backend is configured — forwarded to the
   * ProjectSwitcher's "Plan a new project with AI" door gate. */
  aiConfigured?: boolean;
  /**
   * The actor's settings-area capabilities (Subtask 6.5.2), resolved once in the
   * (authed) layout via `projectAccessService.getSettingsCapabilities`. Drives
   * the settings-nav registry's per-entry `access` filter when the rail is in the
   * project-settings area. Omitted off the settings routes (the project nav never
   * reads it); defaults closed so a missing value never leaks an entry.
   */
  settingsAccess?: SettingsNavCapabilities;
  /**
   * The signed-in user's identity (Subtask 7.8.12) — drives the account-settings
   * area rail header (initial avatar + name + email) when the rail is inside the
   * `/settings/account*` area. Resolved once in the (authed) layout from the
   * session (the same `{ name, email }` the TopNav user menu shows).
   */
  user: { name: string; email: string };
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

export function SidebarNav({
  activeProject,
  projects,
  variant = 'rail',
  settingsAccess,
  user,
  aiConfigured = false,
}: SidebarNavProps) {
  const t = useTranslations('shell');
  const ts = useTranslations('settings');
  const pathname = usePathname();
  const [storeCollapsed] = useSidebarCollapsed();
  const isDrawer = variant === 'drawer';
  // The drawer always renders expanded; the rail follows the shared store.
  const collapsed = isDrawer ? false : storeCollapsed;

  const hasProject = Boolean(activeProject);

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
    const caps = settingsAccess ?? { canBrowse: false, canManage: false };
    const settingsSections: SidebarSection[] = groupSettingsNav(visibleSettingsNav(caps)).map(
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
    sections.push({
      id: 'primary',
      items: [
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
      ],
    });
  }

  sections.push({
    id: 'bottom',
    items: [
      {
        icon: <Settings />,
        label: t('nav.settings'),
        // Deep-link to project settings when a project is active; otherwise
        // there's nothing project-scoped to configure, so go to workspace.
        href: hasProject ? '/settings/project' : '/settings/workspace',
        // Stay un-highlighted when the more-specific Job runs sub-link is the
        // active route, so only one row reads as current.
        active: isActive(pathname, '/settings') && !isActive(pathname, '/settings/workspace/jobs'),
      },
      {
        // Operator surface (Subtask 1.6.5) — the workspace's background-job runs
        // + dead-letter queue. A workspace-scoped settings sub-page.
        icon: <ListChecks />,
        label: t('nav.jobRuns'),
        href: '/settings/workspace/jobs',
        active: isActive(pathname, '/settings/workspace/jobs'),
      },
      {
        icon: <BookOpen />,
        label: t('nav.docs'),
        href: DOCS_URL,
      },
    ],
  });

  return (
    <Sidebar
      header={
        <SidebarHeader
          activeProject={activeProject}
          projects={projects}
          collapsed={collapsed}
          aiConfigured={aiConfigured}
        />
      }
      sections={sections}
      footer={isDrawer ? undefined : <SidebarToggle variant="footer" />}
      collapsed={isDrawer ? false : undefined}
    />
  );
}
