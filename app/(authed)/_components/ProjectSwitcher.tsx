'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import type { ProjectDTO } from '@/lib/dto/projects';
import { setActiveProjectAction } from '../_project-actions';
import { CreateProjectModal } from './CreateProjectModal';

export interface ProjectSwitcherProps {
  /** Non-archived projects in the workspace (the switch targets). */
  projects: ProjectDTO[];
  activeProjectId: string | null;
  /**
   * The resolved active project, used as a fallback to render the trigger
   * name + `archivedAt` flag when the active project is archived and thus
   * NOT present in `projects` (PRODECT_FINDINGS #29.2). Omit it for the
   * normal case — the active project is then found in `projects`.
   */
  activeProject?: ProjectDTO | null;
}

export function ProjectSwitcher({
  projects,
  activeProjectId,
  activeProject,
}: ProjectSwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Prefer the in-list project; fall back to the passed activeProject so an
  // archived active (excluded from `projects`) still renders its name + pill.
  const active = projects.find((p) => p.id === activeProjectId) ?? activeProject ?? null;
  const isArchived = Boolean(active?.archivedAt);

  function handleSwitch(projectId: string) {
    if (projectId === activeProjectId) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      await setActiveProjectAction(projectId);
      setOpen(false);
      // Re-render server components against the new active project.
      router.refresh();
    });
  }

  function openCreate() {
    setOpen(false);
    setCreateOpen(true);
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            size="md"
            aria-label="Switch project"
            // Full-width so it fills the ~216px sidebar-header slot (240px
            // rail minus padding); the chevron pins to the right edge.
            // Open-state affordance mirrors WorkspaceSwitcher: primary
            // border + surface fill while the popover is open.
            className={cn(
              'w-full',
              open && 'bg-(--el-surface) border border-(--el-accent)',
              !active && 'text-(--el-text-muted)',
            )}
          >
            <span className="flex w-full items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-left">
                {active?.name ?? 'No project'}
              </span>
              {isArchived ? (
                // "Archived" is a muted inactive state, not an info severity —
                // neutral tone (AA-safe; #35).
                <Pill tone="neutral" className="shrink-0">
                  Archived
                </Pill>
              ) : null}
              <ChevronDown className="text-(--el-text-muted) h-4 w-4 shrink-0" aria-hidden />
            </span>
          </Button>
        </Popover.Trigger>
        <Popover.Content align="start" width={320} className="py-1">
          <div className="px-3 pb-1 pt-2">
            <span className="text-(--el-text-muted) font-mono text-xs uppercase tracking-wider">
              Projects
            </span>
          </div>
          <ul role="list" className="px-1">
            {projects.map((p) => {
              const isActive = p.id === activeProjectId;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => handleSwitch(p.id)}
                    disabled={isPending}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-2 text-left',
                      'hover:bg-(--el-surface) focus-visible:bg-(--el-surface) focus-visible:outline-none',
                      'disabled:pointer-events-none disabled:opacity-50',
                      isActive && 'bg-(--el-surface)',
                    )}
                  >
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                      {isActive ? (
                        <Check className="h-4 w-4" style={{ color: 'var(--el-accent)' }} />
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        'flex-1 truncate font-sans text-sm text-(--el-text)',
                        isActive && 'font-semibold',
                      )}
                    >
                      {p.name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="my-1 h-px bg-(--el-border)" />
          <div className="px-1 pb-1">
            <button
              type="button"
              onClick={openCreate}
              className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-2 text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
            >
              <Plus className="text-(--el-text-muted) h-4 w-4" aria-hidden />
              Create project
            </button>
          </div>
        </Popover.Content>
      </Popover>

      <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
