import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Sparkles } from 'lucide-react';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { plansService } from '@/lib/services/plansService';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { PlanWithAILauncher } from '@/components/planning/PlanWithAILauncher';

import { buildPlanRowViews } from './planRowView';
import { PlansList } from './_components/PlansList';

// The Plans surface (Story 7.21 · Subtask 7.21.1 / MOTIR-1338) — the index of
// every AI plan (a generation proposal bundle) for the project. The ACCESS PATH
// is the "Plans" left-nav entry in `SidebarNav` (the ai-planning design §5 — a
// planning surface reached from a left-nav entry beside the other project nav
// surfaces). Built to `design/ai-planning/` Panel A.
//
// Server Component (mirrors `/roadmap` + `/ready`): it resolves the active
// project, gates on `canBrowse` (6.4.6), reads the FIRST cursor page of plans
// (services only, never Prisma — 4-layer), enriches each into a row view-model
// (`buildPlanRowViews`: relative time + per-plan staleness count, MOTIR-1340),
// then hands off to the client `PlansList`, which virtualizes + streams more.
// The empty/generate CTA reuses the shipped `PlanWithAILauncher` (MOTIR-1299) —
// never a hand-rolled AI affordance (MOTIR-1300 item 2) — gated on AI being
// configured, exactly like the roadmap empty state. The plan DETAIL each row
// links into is MOTIR-847 (`/plans/[id]`).

export default async function PlansPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('aiPlanning');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        </header>
        <EmptyState title={t('noProjectTitle')} description={t('noProjectDescription')} />
      </div>
    );
  }

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  // The active project may be one the actor can no longer browse (made private
  // while pinned). Gate the read on canBrowse and render the no-access state
  // rather than crashing (the read would otherwise throw). Mirrors /roadmap.
  const caps = await projectAccessService.getCapabilities(ctx.projectId, wsCtx);
  if (!caps.canBrowse) {
    const ta = await getTranslations('projectAccess');
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        </header>
        <NoAccessState
          title={ta('noAccessTitle')}
          description={ta('noAccessDescription')}
          backHref="/dashboard"
          backLabel={ta('backToProjects')}
        />
      </div>
    );
  }

  const firstPage = await plansService.listPlans(ctx.projectId, wsCtx);
  const views = await buildPlanRowViews(firstPage.plans, wsCtx);
  const isEmpty = views.length === 0;
  const aiConfigured = isMotirAiConfigured();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
          <p className="text-sm text-(--el-text-muted)">
            {t('subtitle', { project: ctx.project.name })}
          </p>
        </div>
        {!isEmpty && aiConfigured ? <PlanWithAILauncher context={{ kind: 'project' }} /> : null}
      </header>

      {isEmpty ? (
        <EmptyState
          icon={<Sparkles className="h-12 w-12" aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          action={
            aiConfigured ? (
              <PlanWithAILauncher context={{ kind: 'project', hasPlan: false }} />
            ) : undefined
          }
        />
      ) : (
        <PlansList initialViews={views} initialCursor={firstPage.nextCursor} />
      )}
    </div>
  );
}
