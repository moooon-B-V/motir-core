import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { ProjectSwitcher } from './ProjectSwitcher';
import { UserMenu } from './UserMenu';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import type { ProjectDTO } from '@/lib/dto/projects';

// Top-nav shell for every (authed)/* route. Left cluster: workspace
// switcher + 1px hairline + project switcher (Subtask 1.3.4 minimal form
// — Story 1.5 will move project nav into a left sidebar, at which point
// the top-nav project switcher is demoted or retired). Right cluster: the
// user menu. Story 1.5 (app shell) expands this by composing ATOP this
// structure — add slots inside the existing clusters rather than
// replacing the file. No wordmark slot (brand-mark deferral, PRODECT.md).

export interface TopNavProps {
  workspaces: WorkspaceSummaryDTO[];
  activeWorkspaceId: string | null;
  projects: ProjectDTO[];
  activeProjectId: string | null;
  user: { name: string; email: string };
}

export function TopNav({
  workspaces,
  activeWorkspaceId,
  projects,
  activeProjectId,
  user,
}: TopNavProps) {
  return (
    <header className="border-(--color-hairline) bg-background sticky top-0 z-30 border-b">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-2">
          <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
          {/*
            Hairline divider separating the two switchers. Only rendered
            when there's an active workspace — if the user has no
            workspaces yet, the workspace switcher renders the "Create
            workspace" empty-state button and a trailing divider would be
            visually orphaned.
          */}
          {activeWorkspaceId ? (
            <>
              <div className="h-5 w-px bg-(--color-hairline)" aria-hidden />
              <ProjectSwitcher projects={projects} activeProjectId={activeProjectId} />
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <UserMenu name={user.name} email={user.email} />
        </div>
      </nav>
    </header>
  );
}
