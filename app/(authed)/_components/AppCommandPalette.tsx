'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  CircleDot,
  Columns3,
  Folder,
  LayoutDashboard,
  LayoutList,
  LogOut,
  Plus,
  Settings,
  SunMoon,
  Users,
} from 'lucide-react';
import { CommandPalette, type CommandGroup } from '@/components/ui/CommandPalette';
import { useTheme } from '@/lib/contexts/theme-context';
import { signOut } from '@/lib/auth/client';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import type { ThemePattern } from '@/lib/theme/types';
import { switchWorkspaceAction } from '../_actions';
import { setActiveProjectAction } from '../_project-actions';
import { useCommandPalette } from './CommandPaletteProvider';
import { useCreateIssue } from './CreateIssueProvider';

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
}

export function AppCommandPalette({
  workspaces,
  activeWorkspaceId,
  projects,
  activeProjectId,
  hasProject,
}: AppCommandPaletteProps) {
  const t = useTranslations('shell');
  const { open, setOpen } = useCommandPalette();
  const { openCreateIssue, canCreate } = useCreateIssue();
  const router = useRouter();
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
      router.refresh();
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
        onSelect: () => go('/issues'),
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
    );
  }
  navActions.push({
    id: 'nav-settings',
    label: t('commandPalette.goToSettings'),
    icon: <Settings />,
    onSelect: () => go(hasProject ? '/settings/project' : '/settings/workspace'),
  });
  groups.push({ heading: t('commandPalette.navigationHeading'), actions: navActions });

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
