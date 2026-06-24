import { getTranslations } from 'next-intl/server';
import { ShellTierNav } from './ShellTierNav';
import { UserMenu } from './UserMenu';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';
import { CreateIssueButton } from './CreateIssueButton';
import { BuildInPublicButton } from './build-in-public/BuildInPublicButton';
import { BuildingInPublicHeaderLink } from './build-in-public/BuildingInPublicHeaderLink';
import { ReportButton } from './ReportButton';
import { SidebarToggle } from '@/components/ui/SidebarToggle';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import type { OrganizationDTO } from '@/lib/dto/organizations';
import type { OrgControlActiveOrg } from './OrgControl';

// Top-nav shell for every (authed)/* route, spanning the full width above
// the sidebar+content grid. Left cluster: the mobile hamburger (<md, opens
// the off-canvas SidebarDrawer) + the tenancy-tier nav (the org control,
// always shown, then the workspace switcher only at ≥2 workspaces — Story
// 6.10.5 progressive disclosure, in ShellTierNav). Right cluster: the cmd-K
// "Search" trigger + the tri-state theme toggle (both wired in Subtask 1.5.4) +
// the notification bell (Subtask 5.7.5, per-workspace — only when a workspace
// is active) + the user menu.
//
// The project switcher MOVED to the sidebar header in Subtask 1.5.3 — the
// "Story 1.5 will move project nav into a left sidebar" promise from the
// 1.3.4 minimal form is now fulfilled, so the project switcher (and its
// workspace-gated hairline divider) is gone from here. No wordmark slot
// (brand-mark deferral, MOTIR.md).

export interface TopNavProps {
  activeOrg: OrgControlActiveOrg | null;
  orgs: OrganizationDTO[];
  workspaces: WorkspaceSummaryDTO[];
  activeWorkspaceId: string | null;
  user: { name: string; email: string };
  /** The session user's unread notification count for the active workspace —
   * the bell's initial badge value (resolved once in the layout, then polled by
   * the client). Null when there's no active workspace (the bell is hidden). */
  initialUnreadCount: number | null;
  /** The active project's key when the PRIMARY "Build in public" entry point
   * (Subtask 6.17.3 · design Panel 10a) should show — i.e. the actor can manage
   * a project whose access level is not yet `public`. Null otherwise (no active
   * project, a non-admin, or an already-public project — where the 6.17.6/6.17.7
   * "Building in public" linked indicator takes this same header slot instead).
   * Resolved server-side in the layout. */
  buildInPublicProjectKey: string | null;
  /** Whether the active project is currently building in public
   * (`accessLevel === 'public'`). When true, the same header slot shows the
   * clickable "Building in public" status indicator (Subtask 6.17.7 · design
   * §6.17.6 · Panel 12) linking to the build-in-public settings, shown to ALL
   * team members (no `canManage` read — unlike the non-public CTA above). The
   * two are mutually exclusive by construction (a project is either public or
   * not), so the slot renders exactly ONE — never both, never empty. */
  buildingInPublic: boolean;
  /** True on a Motir cloud build (`MOTIR_CLOUD`) — gates the org menu's
   *  "Billing & plans" row (Story 8.1.7). Resolved server-side in the layout. */
  cloudBilling: boolean;
}

export async function TopNav({
  activeOrg,
  orgs,
  workspaces,
  activeWorkspaceId,
  user,
  initialUnreadCount,
  buildInPublicProjectKey,
  buildingInPublic,
  cloudBilling,
}: TopNavProps) {
  const t = await getTranslations('shell');
  return (
    <header
      // `data-surface="header"` lets a surface-material style treat the top bar
      // as shell chrome — the Hand-Drawn style roughens its bottom edge so the
      // shell frame matches the cards (MOTIR-1315). Inert under styles with no
      // [data-surface='header'] rule.
      data-surface="header"
      className="border-(--el-border) bg-(--el-page-bg) sticky top-0 z-30 border-b"
    >
      {/* `aria-label` names this landmark distinctly from the sidebar's
          "Primary" nav — two unnamed <nav> landmarks fail axe's
          landmark-unique rule and leave screen-reader users unable to tell the
          global bar from the primary rail. */}
      <nav
        aria-label={t('topNav.global')}
        className="flex h-14 items-center justify-between gap-2 px-4 sm:px-6"
      >
        <div className="flex min-w-0 items-center gap-2">
          {/* Mobile-only: opens the off-canvas SidebarDrawer. Hidden ≥md,
              where the persistent rail takes over. */}
          <div className="md:hidden">
            <SidebarToggle variant="hamburger" />
          </div>
          <ShellTierNav
            activeOrg={activeOrg}
            orgs={orgs}
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            cloudBilling={cloudBilling}
          />
        </div>
        <div className="flex items-center gap-2">
          {/* The single stateful build-in-public slot (design §6.17.6 · Panel
              12): the admin "Build in public" CTA when the project is NOT
              public, OR the all-members "Building in public" linked indicator
              when it IS — exactly one, never both, never empty. */}
          {buildInPublicProjectKey ? (
            <BuildInPublicButton projectKey={buildInPublicProjectKey} />
          ) : buildingInPublic ? (
            <BuildingInPublicHeaderLink />
          ) : null}
          <CreateIssueButton />
          <CommandPaletteTrigger />
          <ReportButton />
          <ThemeToggle />
          {initialUnreadCount !== null ? (
            <NotificationBell initialUnreadCount={initialUnreadCount} />
          ) : null}
          <UserMenu name={user.name} email={user.email} />
        </div>
      </nav>
    </header>
  );
}
