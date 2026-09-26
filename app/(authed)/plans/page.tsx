import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Sparkles } from 'lucide-react';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { RoomViewSwitch } from '@/components/rooms/RoomViewSwitch';
import { parseRoomView, pickRoomView, ROOM_VIEW_PARAM } from '@/lib/rooms/roomView';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { planSessionsService } from '@/lib/services/planSessionsService';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { PlanWithAILauncher } from '@/components/planning/PlanWithAILauncher';
// ⚠️ The parser comes from the PURE module, never from `PlanStatusTabs` — that
// one is `'use client'`, and importing even a pure function through a client
// boundary hands this Server Component a client reference that throws on call
// (MOTIR-3243).
import { PLAN_SESSION_LANDING_PARAM, planStateFromParam } from '@/lib/planning/planSessionFilter';

import { buildSessionRowViews } from './sessionRowView';
import { SessionsList } from './_components/SessionsList';
import { PlanStatusTabs } from './_components/PlanStatusTabs';

// The Plans surface — every planning CONVERSATION in the project (MOTIR-6025,
// `agent-authored-plans.md` AMENDMENT 17 §8; built to
// `design/ai-planning/design-notes.md` Part XIX). It listed PLANS until this
// story (Story 7.21 · MOTIR-1338); a conversation that stopped half-way, or never
// proposed anything, was nowhere to be found. Each row now is one conversation:
// what was asked, who started it, when it was last active, and its latest
// plan's state. The ACCESS PATH is unchanged — the "Plans" left-nav entry.
//
// THE VIEW (Story MOTIR-6179 · MOTIR-6334, design MOTIR-6327
// `plans-sessions--view-tabs.mock.html`): Mine / Project. The room's VIEWS come
// from `planSessionsService.roomAccess` — Project on `plan:view_any`, Mine on
// authoring or deciding a plan; both ⇒ the switch, one ⇒ that view alone, none ⇒
// not-found. The plan-state filter works WITHIN the view and its counts are the
// view's. A switch keeps `planState` and drops `session`.
//
// Server Component: resolve the active project, gate on `canBrowse`, read the
// FIRST cursor page of the filter in view plus the filter's counts (services
// only — 4-layer), format each row server-side, then hand off to the client
// `SessionsList`, which virtualizes and streams more.

function firstParam(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function PlansPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  // THE URL IS THE SINGLE SOURCE OF TRUTH for the filter (MOTIR-3241): derived on
  // every render, and an unknown value falls back to All rather than erroring.
  //
  // THE READS ARRIVE IN WAVES, not one await each — the serial-read ratchet
  // (`tests/navigation/loading-boundary-guard.test.ts`, MOTIR-3449).
  const [awaitedParams, session] = await Promise.all([searchParams, getSession()]);
  const params = awaitedParams ?? {};
  const planState = planStateFromParam(firstParam(params.planState));
  // `?session=<id>` — the overlay's fresh-start notice lands here (MOTIR-6024).
  const landingId = firstParam(params.session) || null;
  if (!session) redirect('/sign-in');

  const [t, ta, ctx] = await Promise.all([
    getTranslations('aiPlanning'),
    getTranslations('projectAccess'),
    getActiveProject(),
  ]);
  // UNREACHABLE for a signed-in reader (MOTIR-4870 seeds a default project at
  // the WORKSPACE tier). The guard stays because the type does.
  if (!ctx) redirect('/sign-in');

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  // The active project may be one the actor can no longer browse (made private
  // while pinned) — render the no-access state rather than crashing.
  //
  // ONE WAVE: the browse check, the room's views and — on a clean URL, the one
  // case the default rule consults it — the Mine probe. The room's access read is
  // SETTLED, not caught into a default: an unbrowsable project still reaches the
  // no-access state below, and any other failure is rethrown after it.
  const requested = parseRoomView(params[ROOM_VIEW_PARAM]);
  const sumCounts = (c: Record<string, number>) => Object.values(c).reduce((a, n) => a + n, 0);
  const [caps, accessRead, mineHasRows] = await Promise.all([
    projectAccessService.getCapabilities(ctx.projectId, wsCtx),
    planSessionsService
      .roomAccess(ctx.projectId, wsCtx)
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error })),
    requested === null
      ? planSessionsService
          .countSessionsByPlanState(ctx.projectId, wsCtx, { view: 'mine' })
          .then((counts) => sumCounts(counts) > 0)
          .catch(() => false)
      : null,
  ]);
  if (!caps.canBrowse) {
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

  if (!accessRead.ok) throw accessRead.error;
  const access = accessRead.value;
  if (access.views.length === 0) notFound();
  const view =
    pickRoomView({ requested, available: access.views, mineHasRows }) ?? access.views[0]!;
  const tv = (key: 'subtitle' | 'subtitleMine') =>
    t(`sessions.${key}`, { project: ctx.project.name });
  const header = (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        <p className="text-sm text-(--el-text-muted)">
          {view === 'mine' ? tv('subtitleMine') : tv('subtitle')}
        </p>
      </div>
      {access.views.length > 1 ? (
        // A switch keeps `planState` (the filter means the same in both views)
        // and drops `session` — a landing is an arrival, not a filter.
        <RoomViewSwitch
          value={view}
          label={t('sessions.viewAria')}
          drop={[PLAN_SESSION_LANDING_PARAM]}
        />
      ) : null}
    </header>
  );

  // A FAILED READ IS NOT AN EMPTY ONE (design MOTIR-6327 § the failed read): the
  // first read is caught here and the shipped `ErrorState` renders under the
  // header, the switch staying.
  let reads;
  try {
    reads = await Promise.all([
      planSessionsService.listSessions(ctx.projectId, wsCtx, { planState, view }),
      planSessionsService.countSessionsByPlanState(ctx.projectId, wsCtx, { view }),
      landingId
        ? planSessionsService.getSessionRow(ctx.projectId, landingId, wsCtx, { view })
        : null,
    ]);
  } catch {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <ErrorState
          title={t('sessions.readFailedTitle')}
          description={t('sessions.readFailedBody')}
        />
      </div>
    );
  }
  const [firstPage, counts, landing] = reads;
  // A landed-on session further down the list is PINNED to the top of the first
  // page so it is on screen; the list skips it when its own page streams in.
  // One outside the filter in view is not pinned — the filter is what the
  // reader asked for.
  const landingState = landing ? (landing.latestPlan?.status ?? 'none') : null;
  const pinned =
    landing &&
    (planState === null || planState === landingState) &&
    !firstPage.sessions.some((s) => s.id === landing.id)
      ? [landing, ...firstPage.sessions]
      : firstPage.sessions;
  const views = await buildSessionRowViews(pinned);
  const aiConfigured = isMotirAiConfigured();

  // TWO EMPTINESSES, and they must not say the same thing (Part VII §6). The
  // project-level one is a fact about the COUNTS — no conversation at all — and
  // it is the ONLY state that offers a fresh start (§19.3a). The filtered one
  // keeps the strip, so a reader is never stuck in a filter.
  const total = sumCounts(counts);
  // The fresh start is offered only to a reader who can AUTHOR (design § Plans):
  // a decide-only reader's Mine-empty and a Viewer's Project-empty have no action.
  const launcher =
    aiConfigured && access.canAuthor ? (
      <PlanWithAILauncher context={{ kind: 'project', hasPlan: false }} />
    ) : undefined;

  return (
    <div className="flex flex-col gap-6">
      {/* ONE Plan-with-AI entrance, and it is not this header (MOTIR-3237) —
          `TopNav` carries it on every authed screen. The EMPTY STATE's CTA below
          stays: it is a first-run call to action, as `/roadmap`'s is. */}
      {header}

      {total === 0 ? (
        <EmptyState
          icon={<Sparkles className="h-12 w-12" aria-hidden />}
          title={view === 'mine' ? t('sessions.emptyMineTitle') : t('sessions.emptyTitle')}
          description={
            view === 'mine'
              ? t('sessions.emptyMineDescription')
              : access.canAuthor
                ? t('sessions.emptyDescription')
                : t('sessions.emptyDescriptionRead')
          }
          action={launcher}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <PlanStatusTabs value={planState} counts={counts} />
          {views.length === 0 ? (
            // Nothing in THIS filter. No CTA: the reader's next move is another
            // filter, which is why the strip stays and the copy names where the
            // other conversations are.
            <EmptyState
              title={t('sessions.filteredEmptyTitle')}
              description={
                view === 'mine'
                  ? t('sessions.filteredEmptyDescriptionMine')
                  : t('sessions.filteredEmptyDescription')
              }
            />
          ) : (
            // KEYED ON THE VIEW AND THE FILTER so React REMOUNTS rather than reconciling two
            // result sets: the island seeds its rows and cursor from props in
            // `useState`, which a re-render cannot revisit.
            <SessionsList
              key={`${view}|${planState ?? 'all'}|${landingId ?? ''}`}
              planState={planState}
              view={view}
              initialViews={views}
              initialCursor={firstPage.nextCursor}
              highlightId={landing?.id ?? null}
            />
          )}
        </div>
      )}
    </div>
  );
}
