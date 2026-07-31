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
  let repoView: ProjectRepoEstablishViewDto | null = null;
  let projectKey: string | null = null;
  if (review.status === 'approved') {
    try {
      const project = await projectsService.assertProjectInWorkspace(
        review.projectId,
        ctx.workspaceId,
      );
      projectKey = project.identifier;
      repoView = await projectRepoEstablishService.getEstablishView(review.projectId, ctx);
    } catch (err) {
      console.error('[plans/[id]] could not read the project repository set:', err);
    }
  }

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

      {/* The canvas+chat shell is `h-full`; give it a definite, viewport-relative
          height so it fills the main area without a double scrollbar (topnav +
          the shell's py-6 + this header ≈ 10rem of chrome above it). */}
      <div className="h-[calc(100dvh-10rem)] min-h-[34rem] overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-canvas)">
        <PlanDetail
          initialReview={review}
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
