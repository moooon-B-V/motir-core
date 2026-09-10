'use client';

import type { ProjectDTO } from '@/lib/dto/projects';
import { ProjectSwitcher } from './ProjectSwitcher';

// The PROJECT tier of the shell's context path — the last crumb of
// `org › workspace › project` (MOTIR-2556 · design/shell/design-notes.md
// § *The context row*).
//
// This is what became of `SidebarHeader`: the project stopped being the left
// rail's head and became a tier in the top bar. The rail's collapsed state — the 40px slot with its
// icon-only ProjectAvatar — went with the rail head; a horizontal tier has no
// collapsed form.
//
// It renders the ProjectSwitcher trigger, which shows the name + an "Archived"
// pill itself (it reads activeProject.archivedAt). An archived project is
// excluded from `projects`, so it is passed through `activeProject` for the
// trigger to resolve its name — the PRODECT_FINDINGS #29.2 path, unchanged.
//
// ⚠️ IT HAD A SECOND BRANCH AND NO LONGER DOES (MOTIR-4873). With NO project it
// drew the create-first door — an accent `+` square, a label, and the
// CreateProjectModal — which the rail had drawn before it as a full-width
// lavender Card. That was the SHELL's own answer to a projectless reader, and
// the state is gone: every member is inside a project (MOTIR-4870). Creating an
// ADDITIONAL project is untouched and lives where it belongs, on the switcher
// this now always renders.
//
// The tier is the row's ELASTIC element: everything else in the left cluster is
// fixed-width, so this is what gives when the row runs out. That is why the
// switcher carries `min-w-0` and a truncating label — without `min-w-0` a flex
// child refuses to shrink below its content and the label is overrun by the
// next control instead of ellipsizing (measured at 768px; design § *The ladder*).

export interface ProjectTierProps {
  /**
   * The active project. Still nullable because `ShellTierNav` above it is, and
   * re-typing that chain is not what this card is about — but the tier no
   * longer OFFERS anything in the null case (MOTIR-4873). It renders nothing:
   * absence, not a state with an affordance in it.
   */
  activeProject: ProjectDTO | null;
  /** Non-archived projects in the workspace — the switch targets. */
  projects: ProjectDTO[];
  /** Whether the AI planning backend is configured — forwarded to the
   * ProjectSwitcher's "Plan a new project with AI" door gate. */
  aiConfigured?: boolean;
}

export function ProjectTier({ activeProject, projects, aiConfigured = false }: ProjectTierProps) {
  // No project ⇒ nothing here. Not a create-first door, not a placeholder: the
  // state is not one the product produces for a member, and a tier that draws
  // something for it is a tier teaching that it can happen.
  if (!activeProject) return null;

  return (
    <ProjectSwitcher
      projects={projects}
      activeProjectId={activeProject.id}
      activeProject={activeProject}
      aiConfigured={aiConfigured}
    />
  );
}
