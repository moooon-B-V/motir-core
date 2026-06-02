'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart3,
  CircleDot,
  Columns3,
  Folder,
  LayoutDashboard,
  LogOut,
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
  const { open, setOpen } = useCommandPalette();
  const router = useRouter();
  const { pattern, setPattern } = useTheme();
  const [, startTransition] = useTransition();

  function go(href: string) {
    router.push(href);
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

  // Navigation — project-scoped routes only when a project is active; Settings
  // deep-links the same way the sidebar does (project vs. workspace settings).
  const navActions = [];
  if (hasProject) {
    navActions.push(
      {
        id: 'nav-dashboard',
        label: 'Go to Dashboard',
        icon: <LayoutDashboard />,
        onSelect: () => go('/dashboard'),
      },
      {
        id: 'nav-issues',
        label: 'Go to Issues',
        icon: <CircleDot />,
        onSelect: () => go('/issues'),
      },
      {
        id: 'nav-boards',
        label: 'Go to Boards',
        icon: <Columns3 />,
        onSelect: () => go('/boards'),
      },
      {
        id: 'nav-reports',
        label: 'Go to Reports',
        icon: <BarChart3 />,
        onSelect: () => go('/reports'),
      },
    );
  }
  navActions.push({
    id: 'nav-settings',
    label: 'Go to Settings',
    icon: <Settings />,
    onSelect: () => go(hasProject ? '/settings/project' : '/settings/workspace'),
  });
  groups.push({ heading: 'Navigation', actions: navActions });

  // The active workspace/project isn't a switch target — show it by name with
  // a "Current" tag, and make selecting it a no-op (just closes the palette).
  if (workspaces.length > 0) {
    groups.push({
      heading: 'Workspace',
      actions: workspaces.map((w) => {
        const isCurrent = w.id === activeWorkspaceId;
        return {
          id: `ws-${w.id}`,
          label: isCurrent ? w.name : `Switch to ${w.name}`,
          icon: <Users />,
          keywords: w.name,
          ...(isCurrent ? { badge: 'Current' } : {}),
          onSelect: isCurrent ? () => {} : () => switchWorkspace(w.id),
        };
      }),
    });
  }

  if (projects.length > 0) {
    groups.push({
      heading: 'Project',
      actions: projects.map((p) => {
        const isCurrent = p.id === activeProjectId;
        return {
          id: `proj-${p.id}`,
          label: isCurrent ? p.name : `Switch to ${p.name}`,
          icon: <Folder />,
          keywords: p.name,
          ...(isCurrent ? { badge: 'Current' } : {}),
          onSelect: isCurrent ? () => {} : () => switchProject(p.id),
        };
      }),
    });
  }

  groups.push({
    heading: 'Account',
    actions: [
      { id: 'acct-theme', label: 'Toggle theme', icon: <SunMoon />, onSelect: toggleTheme },
      { id: 'acct-signout', label: 'Sign out', icon: <LogOut />, onSelect: handleSignOut },
    ],
  });

  return <CommandPalette open={open} onOpenChange={setOpen} groups={groups} />;
}
