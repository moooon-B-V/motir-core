// SMOKE ROUTE — placeholder from Subtask 1.1.2; extended in 1.3.4 to
// branch on the projects-empty case so a freshly-signed-in user with no
// projects lands on the "Create your first project" surface rather than
// the bare smoke greeting. Once a real dashboard ships (later Story)
// this branch moves into whatever page owns the landing surface.
//
// Sign-out moved out of this page into the top-nav user menu (Subtask
// 1.2.6); the (authed) layout now renders TopNav + a padded <main>, so
// this page only owns its own content.

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { ProjectsEmptyState } from '../_components/ProjectsEmptyState';

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  // getActiveProject returns null when the workspace has zero projects
  // (it already falls back to the first available project when the
  // membership has no pinned active). That null is our empty-state cue.
  const project = await getActiveProject();
  if (!project) {
    return <ProjectsEmptyState />;
  }

  return (
    <div>
      <h1 className="font-serif text-3xl font-semibold text-foreground">Dashboard</h1>
      <p className="text-muted-foreground mt-2 font-sans text-sm">
        Active project: <strong className="text-foreground">{project.project.name}</strong>
        <span className="text-muted-foreground font-mono"> ({project.project.identifier})</span>
      </p>
    </div>
  );
}
