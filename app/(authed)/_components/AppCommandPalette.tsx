'use client';

import { useTransition } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  CircleDot,
  Columns3,
  Filter,
  Folder,
  History,
  LayoutDashboard,
  LayoutList,
  LogOut,
  Plus,
  Settings,
  Sparkles,
  SunMoon,
  Users,
} from 'lucide-react';
import { planningWorkspaceHref } from '@/lib/planning/launcher';
import { ONBOARDING_RESUME_PATH } from '@/lib/onboarding/resumeVisibility';
import { CommandPalette, type CommandGroup } from '@/components/ui/CommandPalette';
import { useTheme } from '@/lib/contexts/theme-context';
import { signOut } from '@/lib/auth/client';
import {
  PROJECT_SETTINGS_ROUTES,
  visibleSettingsNav,
  type SettingsNavCapabilities,
} from '@/lib/settings/projectSettingsNav';
import { ACCOUNT_SETTINGS_ROUTES } from '@/lib/settings/accountSettingsNav';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import type { ThemePattern } from '@/lib/theme/types';
import { afterContextSwitchTarget } from '@/lib/navigation/afterContextSwitch';
import { switchWorkspaceAction } from '../_actions';
import { setActiveProjectAction } from '../_project-actions';
import { useCommandPalette } from './CommandPaletteProvider';
import { useCreateIssue } from './CreateIssueProvider';
import { useOnboardingResume } from './OnboardingResumeProvider';

/**
 * AppCommandPalette — the application composition over the generic
 * CommandPalette primitive. Assembles the action groups from the same
 * workspace/project data the (authed) layout already fetched, and dispatches
 * each action through the existing Server Actions / router / theme provider.
 *
 * Open state + the ⌘K binding live in CommandPaletteProvider; this component
 * reads them via `useCommandPalette`. Action groups mirror the 1.5.1 cmd-k
 * mockup: Navigation · Workspace · Project · Account.
 *
 * Deferred (logged in PRODECT_FINDINGS): the g-prefix go-to navigation chips
 * shown in the mockup (`g i`, `g b`, …) need two-key sequence support in
 * `useShortcut`, which is out of 1.5.4's scope — the palette primitive already
 * supports per-action `kbd` chips for when that lands.
 */
const THEME_CYCLE: ThemePattern[] = ['light', 'dark', 'system'];

export interface AppCommandPaletteProps {
  workspaces: WorkspaceSummaryDTO[];
  activeWorkspaceId: string | null;
  projects: ProjectDTO[];
  activeProjectId: string | null;
  /** Whether an active project exists — gates the project-scoped nav actions. */
  hasProject: boolean;
  /** Whether AI planning is wired (the cloud/self-host gate) — gates the
   *  "Plan with AI" command, the ⌘K twin of the top-nav hero launcher
   *  (MOTIR-1299). */
  aiPlanningConfigured?: boolean;
  /**
   * The actor's settings-area capabilities (Subtask 6.5.2) — filters the
   * per-section project-settings deep links to the ones they can open. Omitted
   * when there's no active project (no settings sections are shown).
   */
  settingsAccess?: SettingsNavCapabilities;
}

export function AppCommandPalette({
  workspaces,
  activeWorkspaceId,
  projects,
  activeProjectId,
  hasProject,
  settingsAccess,
  aiPlanningConfigured = false,
}: AppCommandPaletteProps) {
  const t = useTranslations('shell');
  const ts = useTranslations('settings');
  const { open, setOpen } = useCommandPalette();
  const { openCreateIssue, canCreate } = useCreateIssue();
  // The "Resume onboarding" ⌘K twin (MOTIR-1533) — same signal the sidebar row reads.
  const canResume = useOnboardingResume();
  const router = useRouter();
  const pathname = usePathname();
  const { pattern, setPattern } = useTheme();
  const [, startTransition] = useTransition();

  function go(href: string) {
    router.push(href);
  }

  function createIssue() {
    setOpen(false); // close the palette before the modal takes focus
    openCreateIssue();
  }

  function switchWorkspace(workspaceId: string) {
    if (workspaceId === activeWorkspaceId) return;
    startTransition(async () => {
      await switchWorkspaceAction(workspaceId);
      // Land on the work-items surface after a workspace switch so a stale,
      // old-workspace-scoped URL / client island doesn't linger (MOTIR-1312);
      // refresh in place only when already there.
      const target = afterContextSwitchTarget(pathname);
      if (target) router.push(target);
      else router.refresh();
    });
  }

  function switchProject(projectId: string) {
    if (projectId === activeProjectId) return;
    startTransition(async () => {
      await setActiveProjectAction(projectId);
      router.refresh();
    });
  }

  function toggleTheme() {
    setPattern(THEME_CYCLE[(THEME_CYCLE.indexOf(pattern) + 1) % THEME_CYCLE.length]!);
  }

  function handleSignOut() {
    startTransition(async () => {
      await signOut();
      router.push('/sign-in');
      router.refresh();
    });
  }

  const groups: CommandGroup[] = [];

  // Plan with AI — the ⌘K twin of the top-nav hero launcher (MOTIR-1299): the
  // universal entrance to the AI planning workspace. Shown only when AI planning
  // is wired AND there's a project to plan into (mirrors the hero pill's mount
  // gate). Project-scoped context, like the header pill.
  if (aiPlanningConfigured && hasProject) {
    const aiActions = [];
    // The "Resume onboarding" twin (MOTIR-1533) — shown ABOVE "Plan with AI",
    // and only when the active project has an in-progress onboarding session,
    // so keyboard users get the same labeled re-entry the sidebar row offers.
    // Routes to the plain workspace path, which resumes at the real step (1487).
    if (canResume) {
      aiActions.push({
        id: 'resume-onboarding',
        label: t('nav.resumeOnboarding'),
        icon: <History />,
        onSelect: () => go(ONBOARDING_RESUME_PATH),
      });
    }
    aiActions.push({
      id: 'plan-with-ai',
      label: t('planWithAI.label'),
      icon: <Sparkles />,
      onSelect: () => go(planningWorkspaceHref({ kind: 'project' })),
    });
    groups.push({
      heading: t('commandPalette.aiHeading'),
      actions: aiActions,
    });
  }

  // Create — the create-issue entry point (one of three: also the top-nav "+"
  // and the "C" shortcut). Only with an active project to create into.
  if (canCreate) {
    groups.push({
      heading: t('commandPalette.createHeading'),
      actions: [
        {
          id: 'create-issue',
          label: t('createIssue.title'),
          icon: <Plus />,
          kbd: 'C',
          onSelect: createIssue,
        },
      ],
    });
  }

  // Navigation — project-scoped routes only when a project is active; Settings
  // deep-links the same way the sidebar does (project vs. workspace settings).
  const navActions = [];
  if (hasProject) {
    navActions.push(
      {
        id: 'nav-dashboard',
        label: t('commandPalette.goToDashboard'),
        icon: <LayoutDashboard />,
        onSelect: () => go('/dashboard'),
      },
      {
        id: 'nav-issues',
        label: t('commandPalette.goToIssues'),
        icon: <CircleDot />,
        onSelect: () => go('/items'),
      },
      {
        id: 'nav-boards',
        label: t('commandPalette.goToBoards'),
        icon: <Columns3 />,
        onSelect: () => go('/boards'),
      },
      {
        id: 'nav-backlog',
        label: t('commandPalette.goToBacklog'),
        icon: <LayoutList />,
        onSelect: () => go('/backlog'),
      },
      {
        id: 'nav-reports',
        label: t('commandPalette.goToReports'),
        icon: <BarChart3 />,
        onSelect: () => go('/reports'),
      },
      {
        id: 'nav-filters',
        label: t('commandPalette.goToFilters'),
        icon: <Filter />,
        onSelect: () => go('/filters'),
      },
    );
  }
  // Settings: without a project there's nothing project-scoped to configure, so a
  // single "Go to settings" deep-links to the WORKSPACE settings. WITH a project,
  // the per-section project-settings entries below replace it (the 6.5.2 registry).
  if (!hasProject) {
    navActions.push({
      id: 'nav-settings',
      label: t('commandPalette.goToSettings'),
      icon: <Settings />,
      onSelect: () => go('/settings/workspace'),
    });
  }
  groups.push({ heading: t('commandPalette.navigationHeading'), actions: navActions });

  // Project settings — per-section deep links generated FROM the settings-nav
  // registry (Subtask 6.5.2), filtered by the actor's access. A new settings page
  // appears here automatically by adding a registry entry (no hand-kept list).
  if (hasProject) {
    const caps: SettingsNavCapabilities = settingsAccess ?? { canBrowse: false, canManage: false };
    const settingsEntries = visibleSettingsNav(caps, PROJECT_SETTINGS_ROUTES);
    if (settingsEntries.length > 0) {
      groups.push({
        heading: ts('nav.eyebrow'),
        actions: settingsEntries.map((entry) => ({
          id: `settings-${entry.id}`,
          label: ts(entry.labelKey),
          icon: <entry.icon />,
          onSelect: () => go(entry.href),
        })),
      });
    }
  }

  // Account settings — per-pane deep links generated FROM the account-settings-nav
  // registry (Subtask 7.8.12), the same source the rail uses. Always available (a
  // personal area, no project/access gating); a new pane appears here automatically
  // by adding a registry entry. Placeholders are excluded (ACCOUNT_SETTINGS_ROUTES).
  groups.push({
    heading: ts('account.eyebrow'),
    actions: ACCOUNT_SETTINGS_ROUTES.map((entry) => ({
      id: `account-settings-${entry.id}`,
      label: ts(`account.nav.${entry.labelKey}`),
      icon: <entry.icon />,
      onSelect: () => go(entry.href),
    })),
  });

  // The active workspace/project isn't a switch target — show it by name with
  // a "Current" tag, and make selecting it a no-op (just closes the palette).
  if (workspaces.length > 0) {
    groups.push({
      heading: t('commandPalette.workspaceHeading'),
      actions: workspaces.map((w) => {
        const isCurrent = w.id === activeWorkspaceId;
        return {
          id: `ws-${w.id}`,
          label: isCurrent ? w.name : t('commandPalette.switchTo', { name: w.name }),
          icon: <Users />,
          keywords: w.name,
          ...(isCurrent ? { badge: t('commandPalette.current') } : {}),
          onSelect: isCurrent ? () => {} : () => switchWorkspace(w.id),
        };
      }),
    });
  }

  if (projects.length > 0) {
    groups.push({
      heading: t('commandPalette.projectHeading'),
      actions: projects.map((p) => {
        const isCurrent = p.id === activeProjectId;
        return {
          id: `proj-${p.id}`,
          label: isCurrent ? p.name : t('commandPalette.switchTo', { name: p.name }),
          icon: <Folder />,
          keywords: p.name,
          ...(isCurrent ? { badge: t('commandPalette.current') } : {}),
          onSelect: isCurrent ? () => {} : () => switchProject(p.id),
        };
      }),
    });
  }

  groups.push({
    heading: t('commandPalette.accountHeading'),
    actions: [
      {
        id: 'acct-theme',
        label: t('account.toggleTheme'),
        icon: <SunMoon />,
        onSelect: toggleTheme,
      },
      {
        id: 'acct-signout',
        label: t('account.signOut'),
        icon: <LogOut />,
        onSelect: handleSignOut,
      },
    ],
  });

  return <CommandPalette open={open} onOpenChange={setOpen} groups={groups} />;
}
