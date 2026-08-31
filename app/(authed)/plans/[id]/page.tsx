import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ChevronLeft } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { planReviewService } from '@/lib/services/planReviewService';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoEstablishService } from '@/lib/services/projectRepoEstablishService';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { PlanDetail } from '@/components/planning/PlanDetail';
import type { ProjectRepoEstablishViewDto } from '@/lib/dto/projectRepos';

// The PLAN DETAIL route (Story 7.21 · Subtask 7.4.5 / MOTIR-847) — `/plans/[id]`,
// the generation-review MODE of the canvas+chat workspace (MOTIR-1193). It MOUNTS
// the reusable canvas (MOTIR-1194) fed ONE plan's proposed PlanItems and the
// review rail, for review → Approve(materialize) / Decline. Reads ONLY the 7.21
// substrate (the `getPlanReview` assembly over `getPlan` / staleness) — never the
// 7.4 generation engine, so 7.21 keeps no dependency on 7.4. The Plans LIST +
// left-nav entry (the access path) is MOTIR-1338; this card is the detail it links
// to.
//
// Server Component (mirrors `/roadmap`): resolve the workspace, read the review
// model, hand off to the client island. A missing plan OR one the actor can't
// browse is a 404 (the no-existence-leak rule — same shape as a private project).

export default async function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { id } = await params;
  const t = await getTranslations('planReview');

  const ctx = await getWorkspaceContext();
  if (!ctx) notFound();

  let review;
  try {
    review = await planReviewService.getPlanReview(id, ctx);
  } catch (err) {
    // A missing plan, or one in a project the actor can't browse, is HIDDEN as a
    // 404 (no existence leak). An `edit`-level denial can't occur on this read
    // (getPlanReview only needs browse).
    if (err instanceof PlanNotFoundError) notFound();
    if (err instanceof ProjectAccessDeniedError) notFound();
    throw err;
  }

  // The ESTABLISH STEP (Story MOTIR-1775 · MOTIR-1782). Once the plan is approved
  // its items are already in the backlog, and the next thing it needs is somewhere
  // for its code to live — so the step takes the CANVAS pane while the review rail
  // stays, still reading "Approved". Read here rather than in the island because
  // the island cannot render a step it has no data for, and a `router.refresh()`
  // (the rail's own update path) re-runs this read.
  //
  // Read ONLY for an approved plan: a `planned` / `generating` / `declined` plan
  // has nothing to establish, and asking would be a wasted GitHub round-trip on
  // every plan page-view. A repo-set read failure NEVER breaks the plan page — the
  // plan is the page's subject and the step is an addition to it — so it degrades
  // to "no step" and the permanent door (MOTIR-1764) still leads back.
  // The project KEY is read for every plan, not only an approved one: the canvas
  // renders the committed roadmap LEVEL a proposal lands in (MOTIR-3083) and that
  // per-level read is keyed by it. The repository-set read stays scoped to an
  // approved plan — it is the establish step's, and a `planned` plan has nothing
  // to establish.
  //
  // MOTIR-3445 — the two run in ONE wave. Both take `review.projectId`, which the
  // gate read above already returned, so neither depends on the other: they were
  // serial only because they were written in sequence. The `projectKey` in the
  // old condition guarded the FIRST read's result and was never an input to the
  // second (which takes `review.projectId` directly), so hoisting the condition
  // to the plan's own status is behaviour-preserving; the guard moves to where
  // the value is actually consumed, in the props below.
  //
  // ⚠️ THE CONDITIONAL STAYS CONDITIONAL — `getEstablishView` is issued only for
  // an approved plan, exactly as before. What changed is that when it IS issued
  // it overlaps the project resolution instead of following it.
  //
  // Each read keeps its OWN catch: either may fail without taking the page down,
  // and a bare `Promise.all` would let one rejection discard the other's result.
  const [projectKey, repoView]: [string | null, ProjectRepoEstablishViewDto | null] =
    await Promise.all([
      projectsService
        .assertProjectInWorkspace(review.projectId, ctx.workspaceId)
        .then((project) => project.identifier)
        .catch((err: unknown) => {
          console.error('[plans/[id]] could not resolve the project:', err);
          return null;
        }),
      review.status === 'approved'
        ? projectRepoEstablishService
            .getEstablishView(review.projectId, ctx)
            .catch((err: unknown) => {
              console.error('[plans/[id]] could not read the project repository set:', err);
              return null;
            })
        : Promise.resolve(null),
    ]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <Link
          href="/plans"
          aria-label={t('backToPlans')}
          className="inline-flex size-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Link>
        <h1 className="min-w-0 truncate font-serif text-xl font-semibold text-(--el-text)">
          {review.title ?? t('untitledPlan')}
        </h1>
      </header>

      {/* THE PANE FILLS THE FOLD (MOTIR-4019, design Part XIII §2).

          The chrome above this box is 133px, MEASURED in Chromium at all four
          viewports rather than summed: the top nav `h-14` plus its 1px bottom
          hairline (57) + the shell's `pt-6` (24) + this page's own header (36) +
          this stack's `gap-4` (16). The shipped value subtracted `8.5rem` (136)
          AND `--shell-bottom-clearance` on top of it — a band the shell has
          already spent as `pb-(--shell-bottom-clearance)`
          (`app/(authed)/layout.tsx`). Net dead band under the graph at 1440x900:
          99px, on a surface whose whole job is showing a plan. At 1366x768 it was
          worse than dead: `min-h-[34rem]` (544) exceeded the computed height
          (536), so the pane grew past its own budget and ate 8px of the shell's
          clearance. (It did NOT make the page scroll — measured at all four —
          which is the one thing the card's own text got wrong.)

          ⚠️ ONE TERM IS A TOKEN, NOT A CONSTANT, and that is why this reads
          `var(--height-control)` where the roadmap's twin reads a flat rem. This
          page's header is a `size-(--height-control)` back-link beside a
          `text-xl` h1 whose line box is 28 — so the header IS one control tall,
          and every `[data-style]` axis redefines that token: 34 / 36 / 38 / 40.
          A hard-coded budget is wrong by up to 4px on seven of the nine styles,
          in a `calc` whose error mode is a scrolling page. The roadmap's 10rem is
          safe from this only because its header is an h1 + subtitle stack, which
          no style axis moves.

          The negative bottom margin is how the pane SPENDS the shell's band
          without making `<main>` scroll — done locally here rather than by
          touching the shell, so no other route's layout moves. `min-h-[34rem]`
          stays and no longer binds (635px at 1366x768, the tightest measured).

          ⚠️ AND THIS PANE DECLARES NO `--canvas-fold-inset`, deliberately —
          the one place it departs from `RoadmapView`'s otherwise identical
          block. That variable lifts the CANVAS's bottom-RIGHT control clear of
          the floating Plan-with-AI orb; here the canvas is the `1fr` of
          `PlanningWorkspace`'s `grid-cols-[1fr_22rem]`, so at `md` and above the
          orb sits over the 22rem REVIEW RAIL and the canvas column ends 309px
          clear of it (measured at 1440x900: orb x 1364-1420, rail x 1055-1407).
          Declaring it would lift a control that has nothing to clear. The inset
          this surface does need is the rail footer's own, and it is MOTIR-4023's. */}
      <div className="mb-[calc(-1*var(--shell-bottom-clearance,1.5rem))] h-[calc(100dvh_-_3.5rem_-_1px_-_1.5rem_-_1rem_-_var(--height-control))] min-h-[34rem] overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-canvas)">
        <PlanDetail
          initialReview={review}
          projectKey={projectKey ?? ''}
          ariaLabel={t('canvasAria')}
          repositorySet={
            repoView && projectKey && repoView.set.rows.length > 0
              ? { projectKey, view: repoView }
              : null
          }
        />
      </div>
    </div>
  );
}
