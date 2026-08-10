import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { OrgControl, type OrgControlActiveOrg } from './OrgControl';
import { ProjectTier } from './ProjectTier';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import type { OrganizationDTO } from '@/lib/dto/organizations';
import type { ProjectDTO } from '@/lib/dto/projects';

// The shell's CONTEXT PATH — `org › workspace › project`, the one row that says
// where you are (Story 6.10.5, then MOTIR-2556 · `design/shell/design-notes.md`
// § *The context row*). Used by the TopNav (`placement="bar"`) and by the mobile
// SidebarDrawer's header (`placement="drawer"`), which carry DIFFERENT parts of
// the path — see below.
//
// ════════════════════════════════════════════════════════════════════════════
// TWO REVEAL AXES — count AND width. Both are load-bearing; neither is a detail.
//
//   COUNT (Story 6.10.5, unchanged): the ORG is always rendered — the permanent
//   anchor, an OPC being just an org of one — and the WORKSPACE switcher only
//   when the active org has ≥2 workspaces. Below that the middle tier is
//   implicit and never shown; there is no "individual" mode. `workspaces` is
//   already scoped to the active org by the layout, so its length IS the test.
//
//   WIDTH (MOTIR-2556): the row is one elastic line and the path is three things
//   that want it, so ancestors collapse from the left as it narrows —
//   the breadcrumb convention, and the only arrangement that MEASURES:
//
//     < md    the PROJECT alone. The ancestors are not lost: the drawer header
//             (this component at placement="drawer") carries `org › workspace`
//             at every width, one tap behind the hamburger.
//     md–xl   `org › project`, the org as its MARK — its name is `xl:inline`.
//     ≥ xl    the full `org › workspace › project`.
//
// THE RULE FOR THE NEXT TIER (design § *The ladder*): the bar's path is closed
// at ONE tier below `md`, TWO from `md`, THREE from `xl`. A tier added to it is
// an `xl`-and-up tier by default; to appear earlier it must displace one, and
// the displaced one needs a drawn home — which is why the drawer header keeps
// the full ancestor path.
//
// The numbers behind that, measured in Chromium against the build's own CSS
// (design § *The measurement*): at `md` the labelled-at-`lg` right cluster
// leaves the left one ~220px and three tiers need ~330px, so the third tier
// cannot appear before `xl`. And the two-tier bar that ships today OVERFLOWS by
// 47px at 320px — the tier nav's assumed 68px floor is unreachable, because
// `OrgControl` and `WorkspaceSwitcher` cannot compress below 112px between
// them. The one-tier band is what closes that.
// ════════════════════════════════════════════════════════════════════════════

export interface ShellTierNavProps {
  activeOrg: OrgControlActiveOrg | null;
  orgs: OrganizationDTO[];
  workspaces: WorkspaceSummaryDTO[];
  activeWorkspaceId: string | null;
  /** True on a Motir cloud build — gates the org menu's "Billing & plans" row
   *  (Story 8.1.7). Resolved server-side and threaded down to OrgControl. */
  cloudBilling: boolean;
  /**
   * WHICH host this instance renders in, and therefore which part of the path
   * it carries. `bar` (the default) is the full ladder above. `drawer` is the
   * ANCESTORS only — `org › workspace`, unconditionally, with no project tier:
   * the drawer is where the bar's below-`md` band sends them, so a project tier
   * here would be the second copy of a control that already has exactly one
   * host.
   */
  placement?: 'bar' | 'drawer';
  /** The active project — the path's last tier. Bar placement only. */
  activeProject?: ProjectDTO | null;
  /** Non-archived projects in the workspace (the switch targets). Bar only. */
  projects?: ProjectDTO[];
  /** Whether AI planning is configured — gates the switcher's "Plan a new
   *  project with AI" door. Bar only. */
  aiConfigured?: boolean;
}

/** The `›` between two tiers. `aria-hidden`: the path's meaning is carried by
 *  the tiers' own accessible names, and a screen reader announcing "single
 *  right-pointing angle quotation mark" between them is noise. */
function Separator({ className }: { className?: string }) {
  return (
    <span aria-hidden className={`text-(--el-text-faint) px-0.5 text-sm ${className ?? ''}`}>
      ›
    </span>
  );
}

export function ShellTierNav({
  activeOrg,
  orgs,
  workspaces,
  activeWorkspaceId,
  cloudBilling,
  placement = 'bar',
  activeProject = null,
  projects = [],
  aiConfigured = false,
}: ShellTierNavProps) {
  const showWorkspaceSwitcher = workspaces.length >= 2;

  // The drawer carries the ancestors, unconditionally and unchanged — this is
  // exactly the cluster that shipped before the project tier existed.
  if (placement === 'drawer') {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <OrgControl activeOrg={activeOrg} orgs={orgs} cloudBilling={cloudBilling} />
        {showWorkspaceSwitcher ? (
          <>
            <Separator />
            <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
          </>
        ) : null}
      </div>
    );
  }

  // The bar. `display: contents` is what makes a whole tier — its separator
  // included — leave the flex row without nesting it in a box that would take
  // width of its own; the wrappers are layout-invisible above their breakpoint
  // and `display: none` below it.
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="hidden md:contents">
        <OrgControl activeOrg={activeOrg} orgs={orgs} cloudBilling={cloudBilling} nameFrom="xl" />
      </span>
      {showWorkspaceSwitcher ? (
        <span className="hidden xl:contents">
          <Separator />
          <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
        </span>
      ) : null}
      <span className="hidden md:contents">
        <Separator />
      </span>
      <ProjectTier activeProject={activeProject} projects={projects} aiConfigured={aiConfigured} />
    </div>
  );
}
