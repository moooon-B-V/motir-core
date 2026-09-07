import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { autoPlanCadenceService } from '@/lib/services/autoPlanCadenceService';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { legalDocumentUrl } from '@/lib/legal/links';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { projectLessonsService } from '@/lib/services/projectLessonsService';
import { LessonLibraryCard, LESSON_PREVIEW_COUNT } from './_components/LessonLibraryCard';
import { canViewLessonLibrary } from './_components/lessonAccess';
import {
  AiPlanningSettingsEditor,
  type AutoPlanPauseView,
} from './_components/AiPlanningSettingsEditor';
import type { AutoPlanPauseDto } from '@/lib/dto/plans';
import { guardSettingsPage } from '../_guard';

// AI-planning project settings — server component (Story 7.13 · Subtask
// MOTIR-919), the surface `design/ai-settings/` specifies. Mounted in the 6.5
// settings AREA through its own PROJECT_SETTINGS_NAV registry entry
// (`ai-planning`, Automation group), which lights both doors — the rail row and
// the ⌘K deep link.
//
// Browse-gated, NOT admin-gated (unlike Automation): every member SEES the
// project's cadence configuration and a non-admin reads it read-only, matching
// the shipped Estimation panel. The write is re-gated in
// `projectAiSettingsService.updateAiSettings` (assertCanManage), so `isAdmin`
// here only governs whether the edit affordances render.
//
// It reads services only (4-layer, never Prisma) and hands the client editor
// typed serializable data: the MOTIR-915 settings DTO, the admin flag, the
// shipped `isMotirAiConfigured()` probe — the server-only env check that drives
// the "Motir AI isn't connected" state (there is deliberately NO in-app
// provisioning CTA; that route does not exist) — and the MOTIR-1740 auto-plan
// PAUSE verdict.
//
// The pause read is `autoPlanCadenceService.getAutoPlanPauseState`, whose
// `pending` IS MOTIR-916's gate predicate, so the banner can never claim the
// cadence is paused while the watcher is firing. Its relative time is formatted
// HERE, against the request's shared `now` (the `planRowView` idiom), so the
// client hydrates without a mismatch and stays presentational.

/** The pause DTO → what the client banner renders (relative time pre-formatted;
 *  `null` when nothing is waiting, which is the overwhelmingly common case). */
function toPauseView(
  pause: AutoPlanPauseDto,
  whenLabel: (iso: string) => string,
): AutoPlanPauseView | null {
  if (!pause.pending || !pause.planId) return null;
  return {
    planId: pause.planId,
    // A plan still `generating` has no `plannedAt` yet; it is seconds old and
    // never stale, so the meta line simply omits the "planned …" clause.
    plannedWhenLabel: pause.plannedAt ? whenLabel(pause.plannedAt) : null,
    itemCount: pause.itemCount,
    stale: pause.stale,
    staleCount: pause.staleCount,
  };
}

export default async function ProjectAiPlanningPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState
          title={t('project.empty.title')}
          description={t('aiPlanning.empty.description')}
        />
      </div>
    );
  }

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `ai-planning`, never re-declared here.
  const refused = await guardSettingsPage('ai-planning', ctx);
  if (refused) return refused;

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  // MOTIR-3559 — allocation row 6: the frame, PLUS the family's only SECOND
  // boundary. The five-way wave below is tier 2; the lesson-library preview is
  // tier 3, because it cannot start until `canViewLessons` comes back out of
  // that wave. Everywhere else in the family the third tier is empty, which is
  // the right shape for a pane that is one card of fields over two reads.
  //
  // The gate is done at this line, so the boundary is safe here and would not
  // have been one line up.
  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      {/* REAL, painted from the gate: both strings are `t(...)` with no
          interpolation from a pending read. */}
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('aiPlanning.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t('aiPlanning.pageDescription')}
        </p>
      </header>

      <Suspense fallback={<SettingsPaneFrame />}>
        <AiPlanningPaneBody
          projectId={ctx.projectId}
          projectKey={ctx.project.identifier}
          projectName={ctx.project.name}
          ctx={ctx}
          wsCtx={wsCtx}
        />
      </Suspense>
    </div>
  );
}

/** Tier 2 — the five-way wave, and the tier-3 boundary it makes possible. */
async function AiPlanningPaneBody({
  projectId,
  projectKey,
  projectName,
  ctx,
  wsCtx,
}: {
  projectId: string;
  projectKey: string;
  projectName: string;
  ctx: Parameters<typeof canViewLessonLibrary>[0];
  wsCtx: { userId: string; workspaceId: string };
}) {
  const t = await getTranslations('settings');
  const [{ canManage }, settings, pause, format, canViewLessons] = await allSettledOrThrow([
    projectAccessService.getManageCapabilities(projectId, wsCtx),
    projectAiSettingsService.getAiSettings(projectKey, wsCtx),
    autoPlanCadenceService.getAutoPlanPauseState(projectId, wsCtx),
    getFormatter(),
    canViewLessonLibrary(ctx),
  ]);

  return (
    <>
      <AiPlanningSettingsEditor
        projectKey={projectKey}
        projectName={projectName}
        settings={settings}
        isAdmin={canManage}
        aiConfigured={isMotirAiConfigured()}
        canViewLessons={canViewLessons}
        /* The published provider table's absolute url, or `null` on a build with
           no legal manifest (Story MOTIR-3665 · MOTIR-3670). Resolved HERE
           because `lib/legal/links.ts` is `server-only` and the editor is a
           client component — the same shape the other three legal-linking
           surfaces use (MOTIR-4010), which also keeps the operator's document
           list out of the client bundle.

           It is NOT a new configuration key: the manifest already carries this
           document, so an operator who has configured `/legal` at all has
           configured this too. */
        providerTableUrl={legalDocumentUrl('model-providers')}
        pause={toPauseView(pause, (iso) => format.relativeTime(new Date(iso)))}
      />

      {/* THE DOOR to the lesson library (Subtask MOTIR-3338 · design §L3) —
          rendered only for an actor holding `lesson:view`, so a non-admin does
          not see it.

          ⚠️ The read is SKIPPED, not merely un-rendered, when the key is absent:
          the service would refuse it anyway (MOTIR-3337 asserts before it calls
          motir-ai), and asking for a payload we would then discard is the
          fetch-then-hide shape that card exists to rule out. Hiding is
          presentation; the destination page and the service are what protect it.

          MOTIR-3559 — and THIS is the family's only third tier. The read cannot
          begin until `canViewLessons` resolves out of the wave above, so the
          preview is genuinely later than the pane around it rather than merely
          further down it. Its own fallback is the card frame again, so the
          region it will occupy is drawn rather than left blank. */}
      {canViewLessons ? (
        <Suspense fallback={<SettingsPaneFrame />}>
          <LessonLibraryPreview
            projectId={projectId}
            wsCtx={wsCtx}
            t={t}
            formatWhen={(iso: string) => format.relativeTime(new Date(iso))}
          />
        </Suspense>
      ) : null}
    </>
  );
}

/** Tier 3 — the lesson-library preview, behind its own boundary. */
async function LessonLibraryPreview({
  projectId,
  wsCtx,
  t,
  formatWhen,
}: {
  projectId: string;
  wsCtx: { userId: string; workspaceId: string };
  t: Awaited<ReturnType<typeof getTranslations<'settings'>>>;
  formatWhen: (iso: string) => string;
}) {
  const lessons = await projectLessonsService.listLessons(projectId, wsCtx, {
    limit: LESSON_PREVIEW_COUNT,
  });

  return (
    <LessonLibraryCard
      lessons={lessons.lessons}
      available={lessons.available}
      href="/settings/project/ai-planning/lessons"
      copy={{
        title: t('aiPlanning.lessons.cardTitle'),
        subtitle: t('aiPlanning.lessons.cardSubtitle'),
        // The LIBRARY's total, never the preview's length — the read asks
        // for LESSON_PREVIEW_COUNT rows and `total` counts them all.
        viewAll: t('aiPlanning.lessons.viewAll', { count: lessons.total }),
        unavailableTitle: t('aiPlanning.lessons.unavailableTitle'),
        unavailableBody: t('aiPlanning.lessons.unavailableBody'),
      }}
      formatWhen={formatWhen}
    />
  );
}
