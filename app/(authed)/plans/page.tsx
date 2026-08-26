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
// ⚠️ The parser comes from the PURE module, never from `PlanStatusTabs` — that
// one is `'use client'`, and importing even a pure function through a client
// boundary hands this Server Component a client reference that throws on call
// (MOTIR-3243). See the note in `lib/planning/planStatusFilter.ts`.
import { planStatusFromParam } from '@/lib/planning/planStatusFilter';

import { buildPlanRowViews } from './planRowView';
import { PlansList } from './_components/PlansList';
import { PlanStatusTabs } from './_components/PlanStatusTabs';

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

export default async function PlansPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  // THE URL IS THE SINGLE SOURCE OF TRUTH for which tab is in view (MOTIR-3241),
  // derived on every render exactly as `ChildPanel` derives `?children=`: a deep
  // link, a reload and browser Back/forward all agree, and there is no local
  // state that can disagree with the address bar. An unknown value falls back to
  // the default rather than erroring — this comes from a URL a person can type.
  const raw = (await searchParams)?.status;
  const status = planStatusFromParam(Array.isArray(raw) ? raw[0] : raw);
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

  // The rows are THIS TAB's, filtered by the query (MOTIR-3235's predicate) and
  // ten a page from that read's own default — never a literal here, and never a
  // client-side filter over a cursor page, which would return a short page while
  // `nextCursor` claimed there was more.
  const [firstPage, counts] = await Promise.all([
    plansService.listPlans(ctx.projectId, wsCtx, { status }),
    plansService.countPlansByStatus(ctx.projectId, wsCtx),
  ]);
  const views = await buildPlanRowViews(firstPage.plans, wsCtx);
  const aiConfigured = isMotirAiConfigured();

  // TWO EMPTINESSES, and they must not say the same thing (Part VII §6). The
  // project-level one is "this project has no plans at all" — which is a fact
  // about the COUNTS, not about the page in hand, now that the page is one tab's
  // slice. The per-tab one is "this project HAS plans, just none in this tab",
  // and it keeps the strip so a reader is never stuck in a tab.
  const totalPlans = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const projectIsEmpty = totalPlans === 0;
  const tabIsEmpty = views.length === 0;

  return (
    <div className="flex flex-col gap-6">
      {/* ONE Plan-with-AI entrance, and it is not this one (MOTIR-3237,
          `design/ai-planning/design-notes.md` Part VII §5). This header used to
          render its own `PlanWithAILauncher` about 200px below the identical one
          `TopNav` puts on every authed screen — a per-surface door MOTIR-1300
          already ruled against, and which the launcher's own header comment says
          it exists to remove. The `flex-wrap justify-between` layout went with
          it: it existed only to position that pill, so the heading block IS the
          header now, exactly as `/roadmap`'s is.

          The EMPTY STATE's CTA below STAYS. It is a first-run call to action,
          not a repeat of the top bar, and `/roadmap`'s empty state carries the
          same one — removing it would leave this surface with a dead-end empty
          state while its sibling kept a live one. */}
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        <p className="text-sm text-(--el-text-muted)">
          {t('subtitle', { project: ctx.project.name })}
        </p>
      </header>

      {projectIsEmpty ? (
        // No plans at all. The strip is HIDDEN here: there is nothing to filter,
        // and four zeroes are four ways of saying the same thing. This state is
        // the shipped `EmptyState` unchanged, CTA included — `/roadmap`'s empty
        // state carries the same one and the two must not diverge.
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
        <div className="flex flex-col gap-4">
          <PlanStatusTabs value={status} counts={counts} />
          {tabIsEmpty ? (
            // Nothing in THIS tab. No generate CTA: repeating "generate your
            // first plan" would be false on its face, and a generate CTA is the
            // wrong answer to *nothing is generating* — the reader's next move
            // is a different tab, which is why the strip stays above this and
            // the copy names where the plans actually are.
            // ⚠️ `stale` TAKES ITS OWN DESCRIPTION (MOTIR-3578,
            // `design/ai-planning/design-notes.md` Part XI §4). The shared one
            // — *this project's other plans are in the remaining tabs* — is a
            // WAYFINDING line, right for a reader who knows what the tab means
            // and is looking for their plan. Nobody knows what a stale plan is
            // on first meeting the tab, so its empty state does the other job
            // the register allows: name the state, then say in one sentence
            // what would put a plan there.
            <EmptyState
              title={t(`tabEmpty.${status}Title`)}
              description={
                status === 'stale' ? t('tabEmpty.staleDescription') : t('tabEmpty.description')
              }
            />
          ) : (
            // KEYED ON THE STATUS so React REMOUNTS rather than reconciling two
            // different result sets: the island seeds its rows and cursor from
            // props in `useState`, which a re-render cannot revisit, so without
            // this a switched tab would append to the previous tab's list.
            <PlansList
              key={status}
              status={status}
              initialViews={views}
              initialCursor={firstPage.nextCursor}
            />
          )}
        </div>
      )}
    </div>
  );
}
