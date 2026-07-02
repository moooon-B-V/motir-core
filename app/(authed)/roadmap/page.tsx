import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Map } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { RoadmapView } from '@/components/planning/RoadmapView';
import type { RoadmapScope } from '@/lib/planning/roadmapClient';
import { PlanWithAILauncher } from '@/components/planning/PlanWithAILauncher';

// The project Roadmap VIEW (Story 7.20 · Subtask 7.20.5 / MOTIR-1011) — the route
// + read-mode wiring that mounts the reusable roadmap canvas (`WorkItemRoadmap` →
// `ProjectRoadmapCanvas`, MOTIR-1194) against the live project tree. This page owns
// the ROUTE and the read-mode wiring + states — NOT the canvas rendering (1194 owns
// the road/node rendering, zoom, drill-down, virtualization). The ACCESS PATH is the
// "Roadmap" primary left-nav entry in `SidebarNav` (the ai-planning design §5 — a
// planning surface is reached from a left-nav entry drawn beside the other project
// nav surfaces, NOT a Board↔Roadmap toggle).
//
// Server Component (mirrors `/boards`): it resolves the active project, gates on
// `canBrowse` (6.4.6), reads ONLY the ROOT level of the per-level roadmap read
// (7.20.4 / MOTIR-1010) to decide empty-vs-populated, then renders the header and
// hands off to the client `WorkItemRoadmap`, which fetches each level on drill. An
// empty project gets the design's empty state with the SHIPPED
// `PlanWithAILauncher` (MOTIR-1299) — never a hand-rolled AI affordance
// (MOTIR-1300 item 2) — gated on AI being configured, exactly like the shell's
// header pill. Unauthenticated → /sign-in; no active project → a hint; no browse
// access → the no-access state.

export default async function RoadmapPage({
  searchParams,
}: {
  // The scope is URL-addressable (MOTIR-1541): `?scope=sprint` opens the roadmap in
  // active-sprint scope, any other/absent value is the default whole-project scope.
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('roadmap');

  const sp = await searchParams;
  const initialScope: RoadmapScope = sp.scope === 'sprint' ? 'sprint' : 'project';

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

  // The active project may be one the actor can no longer browse (it was made
  // private while pinned). Gate the roadmap read on canBrowse and render the
  // no-access state instead of crashing (the read would otherwise throw).
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

  // Read ONLY the root level (a cheap per-level read, MOTIR-1010 — never the whole
  // forest, mistake #91) to choose empty-vs-populated: an empty project gets the
  // design's empty state with the Plan-with-AI CTA, rather than mounting the canvas
  // to show its bare "nothing here" panel. The canvas re-reads the roots itself
  // (cached client-side) when it mounts for the populated case.
  const roots = await workItemsService.getProjectRoadmap(ctx.projectId, null, wsCtx);
  const isEmpty = roots.nodes.length === 0;
  const aiConfigured = isMotirAiConfigured();

  // An empty PROJECT keeps the server empty state (the canvas never mounts). A
  // populated project hands off to the client `RoadmapView`, which owns the scope
  // toggle + the canvas (MOTIR-1382).
  if (isEmpty) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
          <p className="text-sm text-(--el-text-muted)">
            {t('subtitle', { project: ctx.project.name })}
          </p>
        </header>
        <EmptyState
          icon={<Map className="h-12 w-12" aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          action={aiConfigured ? <PlanWithAILauncher context={{ kind: 'roadmap' }} /> : undefined}
        />
      </div>
    );
  }

  // Resolve the active sprint (MOTIR-1382) so the client wrapper can label the
  // sprint-scope subtitle and render the no-active-sprint state for the toggle.
  const activeSprint = await sprintsService.getActiveSprint(ctx.projectId, wsCtx);

  return (
    <RoadmapView
      projectKey={ctx.project.identifier}
      projectName={ctx.project.name}
      ariaLabel={t('canvasAria', { project: ctx.project.name })}
      hasActiveSprint={activeSprint !== null}
      sprintName={activeSprint?.name ?? null}
      sprintGoal={activeSprint?.goal ?? null}
      initialScope={initialScope}
      // Gate the planning-origin cluster (MOTIR-1013) on the SAME immutable
      // onboarding-ran marker the /onboarding redirect reads (Subtask 7.4 /
      // MOTIR-1264): the collapsed "Idea → Discover · Shape · Validate → Plan"
      // milestones assert a planning journey only a truly-onboarded project has,
      // so a never-onboarded project (null marker) omits them.
      showPlanningOrigin={ctx.project.onboardingRanAt != null}
    />
  );
}
