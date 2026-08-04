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
import { workItemCrumbLabel, type CanvasCrumb } from '@/lib/planning/projectCanvasModel';
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
// ⚠️ THE GATES RUN AHEAD OF THE PAINT; CANVAS DATA DOES NOT (Bug MOTIR-2069).
// Everything above `resolvePlanningHostGate` — session, capabilities, the
// onboarding marker — is awaited BEFORE anything renders, because a `no-access`
// actor must never see a workspace frame for a project they cannot browse and a
// never-onboarded project must still redirect. Canvas data is the opposite: the
// page reads NONE of it (see below), so the workspace opens immediately and the
// canvas fills itself in behind a skeleton, with `app/(planning)/loading.tsx`
// covering the navigation ahead of that. Do not reintroduce a roadmap read here
// — that await is precisely the defect this page was fixed for.
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

  // ── THE ROOT-LEVEL READ IS GONE (Bug MOTIR-2069). It used to sit here,
  // awaited, purely to compute a `hasItems` boolean — and awaiting it is what
  // held the whole workspace shut: on a segment with no instant-loading UI,
  // Next.js parks the navigation on the PREVIOUS surface until the slowest
  // await settles, so the workspace loaded first and opened second.
  //
  // It was also REDUNDANT. `PlanChangeCanvas` reads that very same root level
  // itself moments later (`fetchRoadmapLevel(projectKey, null, …)`), so the page
  // was paying a second read of the same rows to pre-answer a question the
  // canvas answers anyway. The empty-canvas decision is not lost — it MOVED to
  // the canvas, which now renders the workspace's own `emptyRoot` when its root
  // level comes back empty, and the workspace's skeleton while it is in flight.
  //
  // The anchor lookup below is therefore the page's ONLY data read: nothing is
  // serial behind anything, and nothing sits between the click and the paint.

  // The entrance's work item, resolved ONCE, server-side (MOTIR-910 + MOTIR-1491 +
  // MOTIR-2070). It answers THREE needs with one read: the client host needs the
  // item's database id to address the MOTIR-909 endpoints (the href carries only
  // the human identifier), the `@`-mention target set opens PRE-FILLED with that
  // item, and the CANVAS opens on the level that CONTAINS it — for which it needs
  // the anchor's ancestor chain, hence the lineage read rather than the bare
  // identifier resolve. Resolved here because no client component may reach the
  // service layer, and a Server Component reading through a service IS the 4-layer
  // shape. The read is the same view-gated resolve the detail page uses, so an item
  // in another tenant or one this actor cannot browse yields no anchor at all — the
  // workspace then opens on the project conversation, at the root level, instead of
  // erroring.
  //
  // It IS awaited — it seeds the host's initial target set AND the canvas's arrival
  // level, both of which are read on the first render — but it is one indexed
  // lookup plus a depth-capped ancestor CTE, and it no longer queues behind a root
  // read (MOTIR-2069). An item-anchored launch used to pay both round-trips end to
  // end.
  let anchorId: string | null = null;
  let initialTarget: PlanningTarget | null = null;
  // The canvas's arrival trail: the anchor's ancestors, root→parent. The LAST crumb
  // is the level the canvas loads, so this lands on the anchor's OWN level with its
  // siblings and dependency edges around it — the context a plan-change conversation
  // about that item needs (the alternative, opening on the anchor's CHILDREN, hides
  // the item itself). A ROOT-level anchor (an epic) has no ancestors, so the trail is
  // empty and the canvas opens at the root exactly as before.
  let initialCanvasTrail: CanvasCrumb[] = [];
  if (launch.itemKey) {
    try {
      const { item: anchor, ancestors } = await workItemsService.getWorkItemWithAncestors(
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
      initialCanvasTrail = ancestors.map((a) => ({
        id: a.id,
        label: workItemCrumbLabel(a.identifier, a.title),
      }));
    } catch {
      anchorId = null;
      initialTarget = null;
      initialCanvasTrail = [];
    }
  }

  return (
    <PlanningWorkspaceHost
      projectKey={ctx.project.identifier}
      projectName={ctx.project.name}
      launch={launch}
      anchorId={anchorId}
      backHref={planningLaunchBackHref(launch)}
      initialTarget={initialTarget}
      initialCanvasTrail={initialCanvasTrail}
    />
  );
}
