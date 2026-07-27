import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { parsePlanningLaunch, planningLaunchBackHref } from '@/lib/planning/launcher';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import { resolvePlanningHostGate } from '@/lib/planning/workspaceHost';
import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';

// The universal planning-workspace HOST for an ESTABLISHED project (Subtask
// MOTIR-1729) — what "Plan with AI" opens on a project that already has a plan.
// Design: `design/ai-chat/plan-change-conversation.mock.html` panel 2 (the
// workspace over an established project), composing
// `planning-workspace.mock.html` (MOTIR-1193).
//
// Before this route, the launcher DEAD-ENDED: `planningWorkspaceHref()` pointed
// at `/onboarding`, nothing read its `?mode=`, and the onboarding-ran redirect
// bounced an established project straight to `/roadmap`. The href now lands
// HERE; only `lib/planning/launcher.ts` changed, so every call site (the TopNav
// pill, the FAB, ⌘K, the roadmap empty state) is untouched.
//
// A Server Component in the 4-layer shape (mirrors `/roadmap`): it resolves the
// session + active project, gates on `canBrowse` (6.4.6), and reads the ROOT
// level of the per-level roadmap read (MOTIR-1010 — never the whole forest,
// mistake #91) through `workItemsService`, then hands off to the client host,
// which mounts the shipped `PlanningWorkspace` + `WorkItemRoadmap`. No client
// component touches the service layer.
//
// ⚠️ The onboarding gates are NOT weakened. A project whose `onboardingRanAt` is
// null is FORWARDED to `/onboarding`, which keeps owning the first-run fork, the
// MOTIR-1259 existing-item router and the MOTIR-1725 migrate hand-off; the
// `/onboarding` → `/roadmap` redirect for an onboarded project is untouched (it
// is simply no longer on the launcher's path). The split rides the SAME
// immutable marker both surfaces read (`resolvePlanningHostGate`).

export default async function PlanningWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('planningWorkspace');
  const ctx = await getActiveProject();

  // The launcher's context, read back off the query. Total by construction — an
  // absent or hand-edited `?mode=` degrades to the project-scoped default.
  const launch = parsePlanningLaunch(await searchParams);

  const wsCtx = ctx ? { userId: ctx.userId, workspaceId: ctx.workspaceId } : null;
  const caps =
    ctx && wsCtx ? await projectAccessService.getCapabilities(ctx.projectId, wsCtx) : null;

  const gate = resolvePlanningHostGate({
    hasActiveProject: ctx !== null,
    canBrowse: caps?.canBrowse ?? false,
    onboardingRanAt: ctx?.project.onboardingRanAt,
  });

  // The `|| !ctx` arms are the same condition as `gate === 'no-project'`, stated
  // so TypeScript narrows the context for the reads below (a gate string can't).
  if (gate === 'no-project' || !ctx || !wsCtx) {
    return (
      <div className="p-6">
        <EmptyState title={t('noProjectTitle')} description={t('noProjectDescription')} />
      </div>
    );
  }

  if (gate === 'no-access') {
    const ta = await getTranslations('projectAccess');
    return (
      <div className="p-6">
        <NoAccessState
          title={ta('noAccessTitle')}
          description={ta('noAccessDescription')}
          backHref="/dashboard"
          backLabel={ta('backToProjects')}
        />
      </div>
    );
  }

  // Never onboarded → onboarding still owns this project (it decides between the
  // start-fresh entrance and the migrate wizard). The host never makes that call.
  if (gate === 'onboarding') redirect('/onboarding');

  // The cheap ROOT-level read (never the forest) — enough to know whether the
  // canvas has anything to draw, so an established-but-emptied project gets an
  // honest empty canvas instead of the canvas's bare "nothing here" panel.
  const roots = await workItemsService.getProjectRoadmap(ctx.projectId, null, wsCtx);

  // The entrance's work item, resolved ONCE, server-side (MOTIR-910 + MOTIR-1491).
  // It answers two needs with one read: the client host needs the item's database
  // id to address the MOTIR-909 endpoints (the href carries only the human
  // identifier), and the `@`-mention target set opens PRE-FILLED with that item.
  // Resolved here because no client component may reach the service layer, and a
  // Server Component reading through a service IS the 4-layer shape. The read is
  // the same view-gated resolve the detail page uses, so an item in another tenant
  // or one this actor cannot browse yields no anchor at all — the workspace then
  // opens on the project conversation instead of erroring.
  let anchorId: string | null = null;
  let initialTarget: PlanningTarget | null = null;
  if (launch.itemKey) {
    try {
      const anchor = await workItemsService.getWorkItemByIdentifier(
        ctx.projectId,
        launch.itemKey,
        wsCtx,
      );
      anchorId = anchor.id;
      initialTarget = {
        id: anchor.id,
        identifier: anchor.identifier,
        title: anchor.title,
        kind: anchor.kind,
      };
    } catch {
      anchorId = null;
      initialTarget = null;
    }
  }

  return (
    <PlanningWorkspaceHost
      projectKey={ctx.project.identifier}
      projectName={ctx.project.name}
      hasItems={roots.nodes.length > 0}
      launch={launch}
      anchorId={anchorId}
      backHref={planningLaunchBackHref(launch)}
      initialTarget={initialTarget}
    />
  );
}
