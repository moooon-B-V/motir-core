'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import type { ProjectDTO } from '@/lib/dto/projects';
import { setActiveProjectAction } from '../_project-actions';
import { CreateProjectModal } from './CreateProjectModal';

export interface ProjectSwitcherProps {
  projects: ProjectDTO[];
  activeProjectId: string | null;
}

export function ProjectSwitcher({ projects, activeProjectId }: ProjectSwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const active = projects.find((p) => p.id === activeProjectId) ?? null;

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
            rightIcon={<ChevronDown className="h-4 w-4" />}
            aria-label="Switch project"
            // Open-state affordance mirrors WorkspaceSwitcher: primary
            // border + surface fill while the popover is open.
            className={cn(
              open && 'bg-surface border border-(--color-primary)',
              !active && 'text-muted-foreground',
            )}
          >
            <span className="max-w-[24ch] truncate">{active?.name ?? 'No project'}</span>
          </Button>
        </Popover.Trigger>
        <Popover.Content align="start" width={320} className="py-1">
          <div className="px-3 pb-1 pt-2">
            <span className="text-muted-foreground font-mono text-xs uppercase tracking-wider">
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
                      'hover:bg-surface focus-visible:bg-surface focus-visible:outline-none',
                      'disabled:pointer-events-none disabled:opacity-50',
                      isActive && 'bg-surface',
                    )}
                  >
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                      {isActive ? (
                        <Check className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        'flex-1 truncate font-sans text-sm text-foreground',
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
          <div className="my-1 h-px bg-(--color-hairline)" />
          <div className="px-1 pb-1">
            <button
              type="button"
              onClick={openCreate}
              className="hover:bg-surface focus-visible:bg-surface flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-2 text-left font-sans text-sm text-foreground focus-visible:outline-none"
            >
              <Plus className="text-muted-foreground h-4 w-4" aria-hidden />
              Create project
            </button>
          </div>
        </Popover.Content>
      </Popover>

      <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
