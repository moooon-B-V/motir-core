'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';
import type { ProjectDTO } from '@/lib/dto/projects';
import { ProjectSwitcher } from './ProjectSwitcher';
import { CreateProjectModal } from './CreateProjectModal';

// The PROJECT tier of the shell's context path — the last crumb of
// `org › workspace › project` (MOTIR-2556 · design/shell/design-notes.md
// § *The context row*).
//
// This is what became of `SidebarHeader`: the project stopped being the left
// rail's head and became a tier in the top bar, so the two states that survive
// the move live here. The rail's third state — the collapsed 40px slot with its
// icon-only ProjectAvatar — went with the rail head; a horizontal tier has no
// collapsed form.
//
//   (a) an active project (archived or not) → the ProjectSwitcher trigger,
//       which renders the name + an "Archived" pill itself (it reads
//       activeProject.archivedAt). The project is excluded from `projects` when
//       archived, so it is passed through `activeProject` for the trigger to
//       resolve its name — the PRODECT_FINDINGS #29.2 path, unchanged.
//   (b) NO project → the create-first door. The rail drew this as a full-width
//       lavender Card; a card is not a tier in a horizontal row, so the design
//       re-homed the same action into the ghost-button grammar the org and
//       workspace tiers already use — the accent `+` square, the label, and the
//       SAME CreateProjectModal.
//
// The tier is the row's ELASTIC element: everything else in the left cluster is
// fixed-width, so this is what gives when the row runs out. That is why both
// branches carry `min-w-0` and a truncating label — without `min-w-0` a flex
// child refuses to shrink below its content and the label is overrun by the
// next control instead of ellipsizing (measured at 768px; design § *The ladder*).

export interface ProjectTierProps {
  activeProject: ProjectDTO | null;
  /** Non-archived projects in the workspace — the switch targets. */
  projects: ProjectDTO[];
  /** Whether the AI planning backend is configured — forwarded to the
   * ProjectSwitcher's "Plan a new project with AI" door gate. */
  aiConfigured?: boolean;
}

export function ProjectTier({ activeProject, projects, aiConfigured = false }: ProjectTierProps) {
  const t = useTranslations('shell');
  const [createOpen, setCreateOpen] = useState(false);

  if (!activeProject) {
    return (
      <>
        <Button
          variant="ghost"
          size="md"
          aria-label={t('project.createFirst')}
          onClick={() => setCreateOpen(true)}
          className="min-w-0 shrink [&>span]:min-w-0"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'bg-(--el-accent) text-(--el-accent-text) flex h-5 w-5 shrink-0',
                'items-center justify-center rounded-(--radius-control)',
              )}
            >
              <Plus className="h-3 w-3" aria-hidden />
            </span>
            {/* font-serif: a tier of the context path wears the headline role,
                the same as the org, workspace and project names beside it. */}
            <span className="min-w-0 max-w-[22ch] truncate font-serif">
              {t('project.createFirst')}
            </span>
          </span>
        </Button>
        <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
      </>
    );
  }

  return (
    <ProjectSwitcher
      projects={projects}
      activeProjectId={activeProject.id}
      activeProject={activeProject}
      aiConfigured={aiConfigured}
    />
  );
}
