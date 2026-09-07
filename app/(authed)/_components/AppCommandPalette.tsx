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
  ShieldCheck,
  Sparkles,
  SunMoon,
  Users,
} from 'lucide-react';
import { useOpenPlanningWorkspace } from '@/lib/hooks/useOpenPlanningWorkspace';
import { PLAN_SPRINTS_HREF } from '../backlog/_components/aiSprintPlanShared';
import { ONBOARDING_RESUME_PATH } from '@/lib/onboarding/resumeVisibility';
import { CommandPalette, type CommandGroup } from '@/components/ui/CommandPalette';
import { useTheme } from '@/lib/contexts/theme-context';
import { signOut } from '@/lib/auth/client';
import {
  PROJECT_SETTINGS_ROUTES,
  toSettingsNavPermissions,
  visibleSettingsNav,
} from '@/lib/settings/projectSettingsNav';
import type { PermissionKey } from '@/lib/permissions/catalog';
import {
  AI_PLANNING_REQUIREMENT,
  canOfferNavDestination,
  satisfiesRequirement,
} from '@/lib/settings/projectNavAccess';
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
import { isWorkspaceTierRevealed } from '@/lib/workspaces/tierDisclosure';
import type { PlanningLaunchContext } from '@/lib/planning/launcher';

/** ⌘K plans the PROJECT — the palette is global and knows no item. */
const PLANNING_CONTEXT: PlanningLaunchContext = { kind: 'project' };

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
   * The actor's resolved permission keys (Subtask MOTIR-2468) — filters the
   * per-section project-settings deep links to the ones they can open. Omitted
   * when there's no active project (no settings sections are shown); an absent
   * value defaults CLOSED, so a missing prop never leaks a deep link.
   */
  settingsPermissions?: readonly PermissionKey[];
  /**
   * Whether public projects exist on this BUILD (`isCloud()`, MOTIR-3908) —
   * resolved on the server in `app/(authed)/layout.tsx` and threaded here for
   * the same reason `settingsPermissions` is: this is a client component.
   *
   * The registry's second axis (MOTIR-4243). The settings deep links are
   * generated FROM the registry, so without it ⌘K would offer **Public page**
   * on a self-hosted build and land the reader on a 404 — the rail's own
   * failure, one surface over. Defaults CLOSED.
   */
  publicProjectsAvailable?: boolean;
}

export function AppCommandPalette({
  workspaces,
  activeWorkspaceId,
  projects,
  activeProjectId,
  hasProject,
  settingsPermissions,
  aiPlanningConfigured = false,
  publicProjectsAvailable = false,
}: AppCommandPaletteProps) {
  const t = useTranslations('shell');
  const ts = useTranslations('settings');
  const tb = useTranslations('backlog');
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

  // The planning workspace is an OVERLAY on the current page (MOTIR-4730), not a
  // destination — so it does not go through `go()`.
  const { open: openPlanningWorkspace } = useOpenPlanningWorkspace(PLANNING_CONTEXT);

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
      // Land on the work-items surface after a project switch so a stale,
      // old-project-scoped URL / client island doesn't linger (MOTIR-1312 /
      // MOTIR-1559); refresh in place only when already there. The action
      // revalidates the layout (it's a DB write, not a cookie), so the pushed
      // route re-renders with the new active project — same as switchWorkspace.
      const target = afterContextSwitchTarget(pathname);
      if (target) router.push(target);
      else router.refresh();
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

  // The actor's keys, resolved once for every gate below (MOTIR-2468 / -2471):
  // the AI entrances, the project navigations and the settings deep links all
  // read this one set, through the same two maps the sidebar reads.
  const held = toSettingsNavPermissions(settingsPermissions);

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
    // MOTIR-2471 — the planning workspace itself needs `ai:plan`, the key
    // `aiGenerationService` / `aiChatService` / `aiPreplanService` all assert.
    // Resume-onboarding above is left alone: it is gated on there BEING an
    // in-progress session of the actor's own, which is a state, not a permission.
    if (satisfiesRequirement(AI_PLANNING_REQUIREMENT, held)) {
      aiActions.push({
        id: 'plan-with-ai',
        label: t('planWithAI.label'),
        icon: <Sparkles />,
        // ⚠️ NOT `go()` (MOTIR-4730). The workspace is an overlay on the page
        // the reader is already on, so this closes the palette and writes the
        // address shallowly — a `router.push` would re-render the page the
        // overlay is about to sit on top of. Closing FIRST is what makes the
        // overlay's focus return land on the palette's trigger rather than on a
        // row that is being unmounted.
        onSelect: () => {
          setOpen(false);
          openPlanningWorkspace();
        },
      });
    }
    // A heading with nothing under it reads as a loading failure — the same rule
    // design panel 2 fixes for the settings rail, one surface over.
    if (aiActions.length > 0) {
      groups.push({
        heading: t('commandPalette.aiHeading'),
        actions: aiActions,
      });
    }
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
  //
  // MOTIR-2471 — each entry is offered only when the actor may reach its
  // destination, resolved through the SAME map `SidebarNav` uses, so ⌘K and the
  // rail can never disagree about which rooms exist for this person. `offerNav`
  // exists so a new entry is one wrapped push rather than a new condition, and
  // the totality test fails on any href the map does not carry.
  const offerNav = <T extends { id: string }>(href: string, action: T): T[] =>
    canOfferNavDestination(href, held) ? [action] : [];
  const navActions = [];
  if (hasProject) {
    navActions.push(
      ...offerNav('/dashboard', {
        id: 'nav-dashboard',
        label: t('commandPalette.goToDashboard'),
        icon: <LayoutDashboard />,
        onSelect: () => go('/dashboard'),
      }),
      ...offerNav('/items', {
        id: 'nav-issues',
        label: t('commandPalette.goToIssues'),
        icon: <CircleDot />,
        onSelect: () => go('/items'),
      }),
      ...offerNav('/boards', {
        id: 'nav-boards',
        label: t('commandPalette.goToBoards'),
        icon: <Columns3 />,
        onSelect: () => go('/boards'),
      }),
      ...offerNav('/backlog', {
        id: 'nav-backlog',
        label: t('commandPalette.goToBacklog'),
        icon: <LayoutList />,
        onSelect: () => go('/backlog'),
      }),
      // The SECOND door onto AI sprint planning (Subtask MOTIR-1750). The
      // primary one is the two-action create-sprint strip on `/backlog`; this
      // entry reaches the SAME action from anywhere, by navigating there with
      // the run already asked for. Registered here — the same registry the
      // shipped "Go to Backlog" / settings deep links come from — so the action
      // has one implementation and two doors, and the cross-surface door is
      // owned rather than left unbuilt.
      //
      // It is offered whenever the project's AI is wired, NOT gated on
      // `aiSprintPlanningEnabled`: with the switch off the backlog shows the
      // door disabled plus the fix hint, which teaches the capability, whereas a
      // palette entry that silently does not exist teaches nothing.
      // AI sprint planning also needs the actor to hold `ai:plan` — the key
      // `aiPreplanService` asserts. Configured-and-refused is a worse offer than
      // absent.
      ...(aiPlanningConfigured && satisfiesRequirement(AI_PLANNING_REQUIREMENT, held)
        ? [
            {
              id: 'backlog-plan-sprints',
              label: tb('aiPlan.commandLabel'),
              icon: <Sparkles />,
              onSelect: () => go(PLAN_SPRINTS_HREF),
            },
          ]
        : []),
      ...offerNav('/reports', {
        id: 'nav-reports',
        label: t('commandPalette.goToReports'),
        icon: <BarChart3 />,
        onSelect: () => go('/reports'),
      }),
      ...offerNav('/filters', {
        id: 'nav-filters',
        label: t('commandPalette.goToFilters'),
        icon: <Filter />,
        onSelect: () => go('/filters'),
      }),
    );
  }
  // Settings: without a project there's nothing project-scoped to configure, so a
  // single "Go to settings" deep-links to the settings home. WITH a project,
  // the per-section project-settings entries below replace it (the 6.5.2 registry).
  //
  // WHICH home depends on progressive disclosure (MOTIR-3502 · organization-tier
  // §6d). Above the reveal threshold that home is the workspace area; at or below
  // it the workspace tier is hidden, its sections are FOLDED IN to
  // `/settings/organization`, and this action targets that instead. It is
  // re-pointed rather than dropped: the action is "go to settings", a settings
  // home exists at every count, and removing the only ⌘K route to it would be a
  // regression this rule does not ask for. `workspaces` is already the org-scoped
  // list the layout hands `ShellTierNav`, so no new prop and no second predicate.
  if (!hasProject) {
    navActions.push({
      id: 'nav-settings',
      label: t('commandPalette.goToSettings'),
      icon: <Settings />,
      onSelect: () =>
        go(
          isWorkspaceTierRevealed(workspaces.length)
            ? '/settings/workspace'
            : '/settings/organization',
        ),
    });
  }
  // Org SECURITY — the require-2FA policy (Story MOTIR-1215 · MOTIR-3646). Not
  // gated on `hasProject`: the pane is ORG-scoped, so it is reachable whatever
  // project is active, and the org menu's own row is the other door onto it.
  // Not gated on the workspace-tier reveal either — an organization exists at
  // every count, unlike the workspace settings home above.
  navActions.push({
    id: 'nav-org-security',
    label: t('commandPalette.goToOrgSecurity'),
    icon: <ShieldCheck />,
    onSelect: () => go('/settings/organization/security'),
  });
  // The WORKSPACE half (MOTIR-3647), under the SAME condition as its rail row:
  // below the tier-reveal threshold `/settings/workspace/security` 404s, so an
  // entry here would offer a dead address. The control is still reachable at
  // that count — through the org-settings fold-in, which the entry above lands
  // beside.
  if (isWorkspaceTierRevealed(workspaces.length)) {
    navActions.push({
      id: 'nav-workspace-security',
      label: t('commandPalette.goToWorkspaceSecurity'),
      icon: <ShieldCheck />,
      onSelect: () => go('/settings/workspace/security'),
    });
  }
  groups.push({ heading: t('commandPalette.navigationHeading'), actions: navActions });

  // Project settings — per-section deep links generated FROM the settings-nav
  // registry (Subtask 6.5.2), filtered by the actor's access. A new settings page
  // appears here automatically by adding a registry entry (no hand-kept list).
  if (hasProject) {
    const settingsEntries = visibleSettingsNav(held, PROJECT_SETTINGS_ROUTES, {
      publicProjectsAvailable,
    });
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
  // by adding a registry entry. `ACCOUNT_SETTINGS_ROUTES` is the destination set —
  // every entry, since MOTIR-4324 retired the reserved-slot flag it used to exclude.
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

  // The primitive's own default placeholder is deliberately generic ("Type a
  // command or search…") because /tokens mounts it as a specimen. The APP's
  // palette names what a person is actually looking for, so the copy is passed
  // in from the catalog — and passing it is also the only way the string is
  // translatable at all (MOTIR-2552).
  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      groups={groups}
      placeholder={t('commandPalette.placeholder')}
    />
  );
}
