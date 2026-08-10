import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { BrandMark } from '@/components/brand/BrandMark';
import { ShellTierNav } from './ShellTierNav';
import { UserMenu } from './UserMenu';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';
import { CreateIssueButton } from './CreateIssueButton';
import { PlanWithAILauncher } from '@/components/planning/PlanWithAILauncher';
import { BuildInPublicButton } from './build-in-public/BuildInPublicButton';
import { BuildingInPublicHeaderLink } from './build-in-public/BuildingInPublicHeaderLink';
import { ReportButton } from './ReportButton';
import { SidebarToggle } from '@/components/ui/SidebarToggle';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { OrganizationDTO } from '@/lib/dto/organizations';
import type { OrgControlActiveOrg } from './OrgControl';

// Top-nav shell for every (authed)/* route, spanning the full width above
// the sidebar+content grid. Left cluster: the mobile hamburger (<md, opens
// the off-canvas SidebarDrawer) + the CONTEXT PATH (ShellTierNav). Right
// cluster: the cmd-K "Search" trigger + the tri-state theme toggle (both wired
// in Subtask 1.5.4) + the notification bell (Subtask 5.7.5, per-workspace —
// only when a workspace is active) + the user menu.
//
// ⚠️ THE PROJECT IS BACK IN THE BAR, and that REVERSES 1.5.3 deliberately
// (Yue, 2026-08-10 · MOTIR-2556 · `design/shell/design-notes.md` § *The context
// row*). This docstring used to record the opposite — that the switcher had
// moved OUT to the sidebar header, fulfilling a 1.3.4 promise — and that is no
// longer true of the file beneath it. The bar now carries the whole path,
// `org › workspace › project`, because where you are is one question and it
// was being answered in two places, in two visual languages, a hundred pixels
// apart. `ShellTierNav` owns the ladder that makes three tiers fit a row that
// measured 69px of slack; read its docstring before changing any of it.
//
// The brand slot this file's docstring used to defer ("No wordmark slot
// (brand-mark deferral)") is now FILLED — MOTIR-1150, design/brand/
// design-notes.md §7a. It sits at the extreme left of the left cluster, before
// the mobile hamburger, with a hairline divider separating it from
// `ShellTierNav`. MARK ONLY, 24px: this cluster already carries org › workspace
// as text, so a wordmark would read as a fourth level of context — and the
// brand sits OUTSIDE that hierarchy, which is what the divider says.
//
// It is a NEW slot, not a substitution. `SidebarHeader` is entirely project
// context (`ProjectSwitcher`, or the create-project CTA when there is no
// project); the 8.3.1 renders established that putting the brand there costs
// the project its identity (design-notes.md §0 finding #3).
//
// ════════════════════════════════════════════════════════════════════════════
// THE CONTROL BUDGET — read this before adding anything to the right cluster.
// (MOTIR-2373 · `design/shell/design-notes.md` § *The rule for the ninth
// control*, quoted verbatim:)
//
//   The below-`md` bar is CLOSED AT FOUR SLOTS. A control added to the right
//   cluster is a `md`-and-up control by default. To appear below `md` it must
//   displace one of the four, and the displaced one must land in the drawer's
//   utility strip — DRAWN, not cited. A control whose label is not
//   breakpoint-gated does not qualify for the bar at all until it is: that is
//   exactly how the widest state in the product came to exist.
//
// The ceiling is arithmetic, not taste. At the smallest viewport the app
// supports (320px): 320 − 32 (px-4 gutters) − 36 (hamburger) − 8 − 8 (gaps) − 68
// (tier-nav floor) = 168px = 4 × 36 + 3 × 8. The pixels move with
// `--height-control` under a `data-style` swap; the slot COUNT does not.
//
//   `< md`      4 slots, icon-only  — palette · create · bell · avatar
//   `md`–`lg`   all 8, icon-only    — the brand has replaced the hamburger, so
//                                     there is nothing left to cover
//   `≥ lg`      all 8, labelled
//
// The label breakpoint is `lg`, NOT `sm`, and a label moves together with its
// `<kbd>` hint chip — that pair is what closes the 640–767px band, where every
// label used to switch on at once (350 → 656px inside a 640px viewport) while
// the hamburger was still mounted (`md:hidden` lives to 767px).
//
// The four displaced controls — the Plan-with-AI pill, the report button, the
// theme toggle, the build-in-public slot — are `hidden md:inline-flex` (the
// display utility is REPLACED, not appended: `.hidden` and `.inline-flex` have
// equal specificity). Three of them are re-homed in `SidebarDrawer`'s utility
// strip (`app/(authed)/layout.tsx`); the pill is DROPPED, because
// `PlanWithAIFab` already ships on every authed screen under the same gate.
// ════════════════════════════════════════════════════════════════════════════

export interface TopNavProps {
  activeOrg: OrgControlActiveOrg | null;
  orgs: OrganizationDTO[];
  workspaces: WorkspaceSummaryDTO[];
  activeWorkspaceId: string | null;
  /** The active project — the LAST tier of the bar's context path (MOTIR-2556).
   *  Null when the workspace has none, which the tier renders as its
   *  create-first door. */
  activeProject: ProjectDTO | null;
  /** Non-archived projects in the workspace — the project tier's switch
   *  targets. */
  projects: ProjectDTO[];
  /** Whether AI planning is configured — gates the project tier's "Plan a new
   *  project with AI" door, the same gate the launcher uses. */
  aiConfigured: boolean;
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
  /** Whether to show the "Plan with AI" hero launcher (MOTIR-1299) — the
   *  universal entrance to the AI planning workspace. True only when AI planning
   *  is configured (the cloud/self-host gate, `isMotirAiConfigured`) AND there's
   *  an active project to plan into. Resolved server-side in the layout. */
  showPlanWithAi: boolean;
}

export async function TopNav({
  activeOrg,
  orgs,
  workspaces,
  activeWorkspaceId,
  activeProject,
  projects,
  aiConfigured,
  user,
  initialUnreadCount,
  buildInPublicProjectKey,
  buildingInPublic,
  cloudBilling,
  showPlanWithAi,
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
          {/* The brand slot (design/brand/design-notes.md §7a). The glyph is
              `aria-hidden`, so this link is the mark's ONLY accessible name —
              the "informative" row of §8's table. Never add a visible wordmark
              here as well: a label plus visible text makes a screen reader
              announce the brand twice.

              ⚠️ `hidden md:flex` — it yields to the hamburger below md, and that
              is a MEASURED constraint, not a preference. This bar overflows at
              375px before the brand is anywhere near it: the right cluster alone
              measures 290–409px inside a 375px viewport depending on which of
              the Plan-with-AI / build-in-public slots are live, so the left
              cluster is squeezed to zero width and its children spill under it.
              On `main` the hamburger sits at x=16–52 and clears the right
              cluster's leading edge (x=69) with room to spare. Adding 57px of
              brand ahead of it moves it to x=73–109 — INSIDE that cluster, where
              `elementFromPoint` at its centre returns the build-in-public
              megaphone and the tap opens nothing. (That is the E2E failure this
              guard is for: `shell-flows` and `settings-area` both time out
              clicking "Open navigation".) Above md the hamburger is gone and
              there is nothing to displace, which is exactly the width §7a draws.

              The overflow ITSELF is a pre-existing shell defect, logged
              separately rather than absorbed here — this card must not silently
              redesign a responsive bar the brand design never drew. */}
          <Link
            href="/dashboard"
            aria-label={t('topNav.brandHome')}
            // The tile (MOTIR-2557 · design/shell § *The brand tile*). The box
            // was always here and simply unpainted; it now takes an
            // `--el-surface` field and an `--el-border` hairline, and the
            // hairline DIVIDER that used to follow it is gone — the tile's own
            // edge says what the divider said, and that returns 9px to a row
            // measured at 69px of slack.
            //
            // Deliberately NOT a tint: OrgControl's avatar is a 20px
            // `--el-tint-lavender` tile and ProjectAvatar an
            // `--el-avatar-lavender` one, so a third lavender square 20px away
            // would read as another tier chip instead of as the brand. The
            // glyph keeps `--el-accent-on-surface` — the token whose name is
            // literally this composition — so `.brand-glyph`'s GLOBAL rule,
            // shared with auth / explore / public / OG / the specimen, is not
            // touched. 6.03:1 light, 4.24:1 dark; asserted in
            // tests/theme/brand-tile-contrast.test.ts, because the ink guard
            // cannot see a pair whose ink lives in a stylesheet.
            className="hidden h-8 w-8 flex-none items-center justify-center rounded-(--radius-control) border border-(--el-border) bg-(--el-surface) md:flex"
          >
            <BrandMark variant="mark" size={24} />
          </Link>
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
            placement="bar"
            activeProject={activeProject}
            projects={projects}
            aiConfigured={aiConfigured}
          />
        </div>
        {/* `flex-none`: the right cluster may no longer take width from the
            left one. Its children are fixed-size boxes, so as a shrinkable flex
            item it squeezed its `min-w-0` sibling to ZERO and painted over the
            hamburger — the defect this budget closes. */}
        <div className="flex flex-none items-center gap-2">
          {/* The "Plan with AI" hero launcher (MOTIR-1299) — the universal
              entrance to the AI planning workspace, present on every screen as
              the leading hero of the right cluster. The header context is
              project-scoped; the detail panel (MOTIR-910) + roadmap toggle
              (MOTIR-1011) reuse the same component with their own context.
              `placement="bar"` DROPS it below md: the PlanWithAIFab orb ships on
              every authed screen under this same gate, so the entrance survives
              at phone width without costing a slot. */}
          {showPlanWithAi ? (
            <PlanWithAILauncher context={{ kind: 'project' }} placement="bar" />
          ) : null}
          {/* The single stateful build-in-public slot (design §6.17.6 · Panel
              12): the admin "Build in public" CTA when the project is NOT
              public, OR the all-members "Building in public" linked indicator
              when it IS — exactly one, never both, never empty. Below md BOTH
              states move to the drawer's utility strip, which is what stops the
              two-state slot from being a width variable. */}
          {buildInPublicProjectKey ? (
            <BuildInPublicButton projectKey={buildInPublicProjectKey} placement="bar" />
          ) : buildingInPublic ? (
            <BuildingInPublicHeaderLink placement="bar" />
          ) : null}
          <CreateIssueButton />
          <CommandPaletteTrigger />
          <ReportButton display="shell" />
          <ThemeToggle placement="bar" />
          {initialUnreadCount !== null ? (
            <NotificationBell initialUnreadCount={initialUnreadCount} />
          ) : null}
          <UserMenu name={user.name} email={user.email} />
        </div>
      </nav>
    </header>
  );
}
