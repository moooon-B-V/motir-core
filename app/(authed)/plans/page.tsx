import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Sparkles } from 'lucide-react';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { planSessionsService } from '@/lib/services/planSessionsService';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { PlanWithAILauncher } from '@/components/planning/PlanWithAILauncher';
// ⚠️ The parser comes from the PURE module, never from `PlanStatusTabs` — that
// one is `'use client'`, and importing even a pure function through a client
// boundary hands this Server Component a client reference that throws on call
// (MOTIR-3243).
import { planStateFromParam } from '@/lib/planning/planSessionFilter';

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
  const params = (await searchParams) ?? {};
  const planState = planStateFromParam(firstParam(params.planState));
  // `?session=<id>` — the overlay's fresh-start notice lands here (MOTIR-6024).
  const landingId = firstParam(params.session) || null;
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('aiPlanning');

  const ctx = await getActiveProject();
  // UNREACHABLE for a signed-in reader (MOTIR-4870 seeds a default project at
  // the WORKSPACE tier). The guard stays because the type does.
  if (!ctx) redirect('/sign-in');

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  // The active project may be one the actor can no longer browse (made private
  // while pinned) — render the no-access state rather than crashing.
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

  const [firstPage, counts, landing] = await Promise.all([
    planSessionsService.listSessions(ctx.projectId, wsCtx, { planState }),
    planSessionsService.countSessionsByPlanState(ctx.projectId, wsCtx),
    landingId ? planSessionsService.getSessionRow(ctx.projectId, landingId, wsCtx) : null,
  ]);
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
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return (
    <div className="flex flex-col gap-6">
      {/* ONE Plan-with-AI entrance, and it is not this header (MOTIR-3237) —
          `TopNav` carries it on every authed screen. The EMPTY STATE's CTA below
          stays: it is a first-run call to action, as `/roadmap`'s is. */}
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        <p className="text-sm text-(--el-text-muted)">
          {t('sessions.subtitle', { project: ctx.project.name })}
        </p>
      </header>

      {total === 0 ? (
        <EmptyState
          icon={<Sparkles className="h-12 w-12" aria-hidden />}
          title={t('sessions.emptyTitle')}
          description={t('sessions.emptyDescription')}
          action={
            aiConfigured ? (
              <PlanWithAILauncher context={{ kind: 'project', hasPlan: false }} />
            ) : undefined
          }
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
              description={t('sessions.filteredEmptyDescription')}
            />
          ) : (
            // KEYED ON THE FILTER so React REMOUNTS rather than reconciling two
            // result sets: the island seeds its rows and cursor from props in
            // `useState`, which a re-render cannot revisit.
            <SessionsList
              key={`${planState ?? 'all'}|${landingId ?? ''}`}
              planState={planState}
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
