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
import { workItemCrumbLabel, type CanvasCrumb } from '@/lib/planning/projectCanvasModel';
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

// THE ARRIVAL LEVEL (MOTIR-3836). `?item=MOTIR-1234` means "the canvas is showing
// MOTIR-1234's CHILDREN" — you are INSIDE it, which is where a drill leaves you —
// so the trail is `ancestors ++ [the item itself]` and its LAST crumb is the level
// the canvas loads. (Deliberately one crumb deeper than the planning overlay's
// own `planItem=` anchor, which
// opens on the anchor's OWN level so the anchor is visible; the two surfaces want
// different things and keep the same param name.)
//
// Resolved through the same view-gated read the planning overlay's anchor route
// uses (`GET /api/work-items/planning-anchor`), with the same SILENT
// catch: an unknown key, another project's item, an archived one, or one this actor
// cannot browse all yield an empty trail and the roadmap opens at its root. A stale
// link is not a failure — it is a level that no longer exists — so there is no error
// surface and no redirect. The `?item=` param is left in the URL rather than
// rewritten, because a history write on load is a worse surprise than a stale param.
async function resolveArrivalTrail(
  projectId: string,
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined,
  wsCtx: { userId: string; workspaceId: string },
): Promise<CanvasCrumb[]> {
  const itemParam = (await searchParams)?.['item'];
  // A repeated `?item=` arrives as an array; there is no right answer to which
  // one was meant, so the level is the root.
  const itemKey = typeof itemParam === 'string' ? itemParam : null;
  if (!itemKey) return [];
  try {
    const { item, ancestors } = await workItemsService.getWorkItemWithAncestors(
      projectId,
      itemKey,
      wsCtx,
    );
    return [...ancestors, item].map((a) => ({
      id: a.id,
      crumbKey: a.identifier,
      label: workItemCrumbLabel(a.identifier, a.title),
    }));
  } catch {
    return [];
  }
}

// ⚠️ MODULE SCOPE ON PURPOSE — do not fold this back into the page body.
// `loading-boundary-guard`'s serial-read ratchet counts the awaits in the page
// function's OWN body, and a nested helper's await is counted there even though
// this one runs INSIDE the `Promise.all` wave, concurrently with the sprint read.
// Nested, the page measured 6 and the ratchet read a sixth SERIAL read that does
// not exist; hoisted, it measures the 5 waves the page actually arrives in. The
// closure over `searchParams` / `wsCtx` is what nested it — both are parameters
// now, which is also what makes it callable from a test on its own.

export default async function RoadmapPage({
  searchParams,
}: {
  // `?item=<KEY>` — the DRILLED LEVEL, restored on a cold arrival (MOTIR-3836):
  // a reload, a pasted link, a bookmark. `?scope=` stays the client island's
  // (MOTIR-1541); this one has to be resolved here because the ancestor chain is a
  // browse-gated read and the browser has nothing at first paint.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
  // Defaulted, so the page's own guard file (`tests/planning/roadmapPageStreaming`)
  // keeps calling it with no arguments and stays unmodified by this card.
} = {}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('roadmap');

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
  // sprint-scope subtitle and render the no-active-sprint state for the toggle —
  // CONCURRENTLY with the arrival-level resolve below, which is independent of it.
  //
  // ⚠️ This is NOT the concurrency change `design/roadmap/design-notes.md`'s
  // MOTIR-3445 amendment REFUSED, and the distinction is the empty branch. That one
  // would have paired `getProjectRoadmap` with `getActiveSprint`, and the page
  // RETURNS EARLY for an empty roadmap — so a first-run project would have paid for
  // a sprint read it never uses. Both reads here sit AFTER that branch, so nobody
  // pays for one they do not need, and the `?item=` path costs one round trip
  // rather than two.
  const [activeSprint, initialTrail] = await Promise.all([
    sprintsService.getActiveSprint(ctx.projectId, wsCtx),
    resolveArrivalTrail(ctx.projectId, searchParams, wsCtx),
  ]);

  return (
    <RoadmapView
      initialTrail={initialTrail}
      projectKey={ctx.project.identifier}
      projectName={ctx.project.name}
      ariaLabel={t('canvasAria', { project: ctx.project.name })}
      hasActiveSprint={activeSprint !== null}
      sprintName={activeSprint?.name ?? null}
      sprintGoal={activeSprint?.goal ?? null}
      // Gate the planning-origin cluster (MOTIR-1013) on the SAME immutable
      // onboarding-ran marker the /onboarding redirect reads (Subtask 7.4 /
      // MOTIR-1264): the collapsed "Idea → Discover · Shape · Validate → Plan"
      // milestones assert a planning journey only a truly-onboarded project has,
      // so a never-onboarded project (null marker) omits them.
      showPlanningOrigin={ctx.project.onboardingRanAt != null}
    />
  );
}
