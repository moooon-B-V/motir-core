'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Plus, Sparkles } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { CreateProjectModal } from './CreateProjectModal';

// Empty-state surface shown when the active workspace has zero projects.
// The literal "PROD-1" in the description is intentional — there is no
// project yet, so there's no real identifier to interpolate.
//
// Two peer "start a project" doors (MOTIR-1485 / 1486): the accent AI door
// LEADS (Motir is chat-first, Principle #1) and routes into the shipped
// /onboarding fork (MOTIR-1462) — it does NOT pre-create a project or draw a
// second chooser; the kept "Create project" door opens the shipped modal,
// unchanged.

export function ProjectsEmptyState() {
  const t = useTranslations('shell');
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <EmptyState
        icon={
          <span className="bg-(--el-tint-lavender) text-(--el-accent-on-surface) inline-flex h-12 w-12 items-center justify-center rounded-(--radius-card)">
            <Sparkles className="h-6 w-6" aria-hidden />
          </span>
        }
        title={t('project.createFirst')}
        description={t('project.emptyDescription')}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link href="/onboarding" className={buttonVariants({ variant: 'primary' })}>
              <Sparkles className="h-4 w-4" aria-hidden />
              {t('project.planWithAi')}
            </Link>
            <Button
              variant="secondary"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setCreateOpen(true)}
            >
              {t('project.create')}
            </Button>
          </div>
        }
      />
      <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
