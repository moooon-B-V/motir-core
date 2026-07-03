'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FolderOpen, Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { startNewAiProjectAction } from '../_project-actions';
import { CreateProjectModal } from './CreateProjectModal';

// Empty-state surface shown when the active workspace has zero projects.
// The literal "PROD-1" in the description is intentional — there is no
// project yet, so there's no real identifier to interpolate.
//
// Two peer "start a project" doors (MOTIR-1485 / 1486): the accent AI door
// LEADS (Motir is chat-first, Principle #1). It mints a fresh DRAFT project and
// hands off to the shipped /onboarding fork (MOTIR-1462) scoped to that new
// project; the kept "Create project" door opens the shipped modal, unchanged.
// The AI door + its AI-forward treatment only show when the AI backend is
// configured (same gate as the "Plan with AI" launcher); otherwise this is the
// original manual-only empty state.

export interface ProjectsEmptyStateProps {
  /**
   * Whether the AI planning backend is configured (server-resolved via
   * `isMotirAiConfigured()`). Off → the manual "Create project" empty state.
   */
  aiConfigured?: boolean;
}

export function ProjectsEmptyState({ aiConfigured = false }: ProjectsEmptyStateProps) {
  const t = useTranslations('shell');
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <EmptyState
        icon={
          aiConfigured ? (
            <span className="bg-(--el-tint-lavender) text-(--el-accent-on-surface) inline-flex h-12 w-12 items-center justify-center rounded-(--radius-card)">
              <Sparkles className="h-6 w-6" aria-hidden />
            </span>
          ) : (
            <FolderOpen className="h-12 w-12" aria-hidden />
          )
        }
        title={t('project.createFirst')}
        description={t('project.emptyDescription')}
        action={
          aiConfigured ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <form action={startNewAiProjectAction}>
                <Button variant="primary" type="submit" leftIcon={<Sparkles className="h-4 w-4" />}>
                  {t('project.planWithAi')}
                </Button>
              </form>
              <Button
                variant="secondary"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => setCreateOpen(true)}
              >
                {t('project.create')}
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setCreateOpen(true)}
            >
              {t('project.create')}
            </Button>
          )
        }
      />
      <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
