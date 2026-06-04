import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';

// Shared body for the project-scoped placeholder routes (Issues / Boards /
// Reports). Each route is a one-liner that composes this; Epic 2 / 3 / 6
// replace the placeholder body with the real surface.
//
// When the active project is archived (PRODECT_FINDINGS #29.2), every
// project-scoped page renders the "this project is archived" empty state
// instead of its content — the nav stays visible so the user can switch
// away via the sidebar ProjectSwitcher. The archived flag rides on the
// shared getActiveProject() context (ProjectDTO.archivedAt), so no extra
// fetch or React context is needed.

export interface ProjectStubPageProps {
  title: string;
  /** e.g. "Epic 2" — which epic ships the real surface. */
  comingIn: string;
}

export async function ProjectStubPage({ title, comingIn }: ProjectStubPageProps) {
  const active = await getActiveProject();

  if (active?.project.archivedAt) {
    return (
      <EmptyState
        title="This project is archived"
        description="Switch to another project to continue working."
      />
    );
  }

  return (
    <div className="space-y-2">
      <h1 className="font-serif text-2xl">{title}</h1>
      <p className="text-(--el-text-muted)">Coming in {comingIn}.</p>
    </div>
  );
}
