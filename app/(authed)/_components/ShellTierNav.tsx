import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { OrgControl, type OrgControlActiveOrg } from './OrgControl';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import type { OrganizationDTO } from '@/lib/dto/organizations';

// The shell's tenancy-tier cluster (Story 6.10.5, design/org-admin panel 1) —
// PROGRESSIVE DISCLOSURE in one place, used by both the TopNav (≥md) and the
// mobile SidebarDrawer header so they stay in lockstep:
//
//   - The ORG control is ALWAYS rendered (the permanent top-left anchor; an OPC
//     is just an org of one).
//   - The WORKSPACE switcher is rendered ONLY when the active org has ≥2
//     workspaces, to the RIGHT of the org with a `›` separator
//     (`Acme › Engineering`). Below that threshold the middle tier is implicit
//     and never shown — there is no "individual" mode.
//
// `workspaces` is already scoped to the active org by the layout, so its length
// IS the active org's workspace count for the reveal test.

export interface ShellTierNavProps {
  activeOrg: OrgControlActiveOrg | null;
  orgs: OrganizationDTO[];
  workspaces: WorkspaceSummaryDTO[];
  activeWorkspaceId: string | null;
}

export function ShellTierNav({
  activeOrg,
  orgs,
  workspaces,
  activeWorkspaceId,
}: ShellTierNavProps) {
  const showWorkspaceSwitcher = workspaces.length >= 2;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <OrgControl activeOrg={activeOrg} orgs={orgs} />
      {showWorkspaceSwitcher ? (
        <>
          <span aria-hidden className="text-(--el-text-faint) px-0.5 text-sm">
            ›
          </span>
          <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
        </>
      ) : null}
    </div>
  );
}
