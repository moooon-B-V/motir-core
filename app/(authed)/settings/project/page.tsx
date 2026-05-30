import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { ArchiveProjectCard } from './_components/ArchiveProjectCard';

// Project settings — server component. Reads the active project context
// and renders the cards. Only the archive card lands in 1.3.4; rename
// + identifier-change land later. All mutations route through Server
// Actions in app/(authed)/_project-actions.ts.

export default async function ProjectSettingsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const project = await getActiveProject();
  if (!project) {
    // No active project — the user has no projects yet, or just archived
    // the last one. The empty state on /dashboard owns the create CTA;
    // here we surface a static hint so this route doesn't 404.
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState
          title="No project yet"
          description="Create a project from the switcher in the top-left to get started."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-foreground">Project settings</h1>
        <p className="text-muted-foreground font-sans text-sm">
          Manage the active project&apos;s lifecycle.
        </p>
      </header>

      <ArchiveProjectCard
        projectId={project.projectId}
        projectName={project.project.name}
        projectIdentifier={project.project.identifier}
      />
    </div>
  );
}
