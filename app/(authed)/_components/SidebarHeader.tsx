'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { cn } from '@/lib/utils/cn';
import type { ProjectDTO } from '@/lib/dto/projects';
import { ProjectSwitcher } from './ProjectSwitcher';
import { CreateProjectModal } from './CreateProjectModal';

// The sidebar's top slot — the project context for the active workspace.
// Resolves the three states PRODECT_FINDINGS #29 pins for Subtask 1.5.3:
//
//   (#29.1) zero non-archived projects → a lavender CTA card that opens the
//           existing create-project modal in place of the switcher.
//   (#29.2) active project archived     → the ProjectSwitcher trigger, which
//           renders the name + an "Archived" pill (it reads activeProject.
//           archivedAt). The project is excluded from `projects`, so we pass
//           it through `activeProject` for the trigger to resolve its name.
//   (default) an active non-archived project → the ProjectSwitcher.
//
// The layout passes data only; the render-path branch lives here. The
// `collapsed` prop mirrors the Sidebar's: the desktop rail leaves it
// undefined (the component reads the shared store via where it's composed —
// the caller passes the resolved boolean), the mobile drawer passes false so
// the header always renders expanded. When collapsed the slot is ~40px wide,
// so we render an icon-only affordance instead of the full trigger/card.

export interface SidebarHeaderProps {
  activeProject: ProjectDTO | null;
  projects: ProjectDTO[];
  /** When true, render the icon-only (40px) affordance. Default false. */
  collapsed?: boolean;
}

export function SidebarHeader({ activeProject, projects, collapsed = false }: SidebarHeaderProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const hasProject = Boolean(activeProject);

  // Collapsed rail (56px): an avatar-sized square. With a project it shows
  // the name's initial; without one it's a "+" that opens the create modal.
  if (collapsed) {
    const initial = activeProject?.name.trim().charAt(0).toUpperCase() || '+';
    return (
      <>
        <button
          type="button"
          aria-label={hasProject ? 'Active project' : 'Create your first project'}
          onClick={hasProject ? undefined : () => setCreateOpen(true)}
          className={cn(
            'bg-(--el-accent) text-(--el-accent-text) mx-auto flex h-8 w-8 items-center justify-center',
            'rounded-(--radius-sm) font-sans text-sm font-semibold',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
            hasProject && 'pointer-events-none',
          )}
        >
          {hasProject ? initial : <Plus className="h-4 w-4" aria-hidden />}
        </button>
        {!hasProject ? <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} /> : null}
      </>
    );
  }

  // Expanded, no project (#29.1): the primary-tinted "create first project"
  // CTA card in place of the switcher. Composes the create-project modal —
  // the same one ProjectsEmptyState opens.
  if (!hasProject) {
    return (
      <>
        <Card
          tint="lavender"
          clickable
          onClick={() => setCreateOpen(true)}
          aria-label="Create your first project"
          className="flex items-center gap-2 p-2"
        >
          <span className="bg-(--el-accent) text-(--el-accent-text) flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius-xs)">
            <Plus className="h-4 w-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <SectionLabel label="Project" />
            <span className="text-(--el-text) block truncate font-sans text-sm font-medium">
              Create your first project
            </span>
          </span>
        </Card>
        <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
      </>
    );
  }

  // Expanded with a project (archived or not, #29.2 + default). The switcher
  // renders the "Archived" pill itself when activeProject.archivedAt is set.
  return (
    <ProjectSwitcher
      projects={projects}
      activeProjectId={activeProject?.id ?? null}
      activeProject={activeProject}
    />
  );
}
