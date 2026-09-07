import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';

// The planning workspace's LOADING shape (Bug MOTIR-2069). The `/planning` ROUTE
// used to paint NOTHING until the roadmap read resolved: the segment had no
// `loading.tsx` and no `<Suspense>`, so Next.js held the navigation on the
// PREVIOUS route until the page's slowest await settled — the workspace loaded
// first and opened second, which is the inverse of what the flagship "Plan with
// AI" entrance should feel like.
//
// ⚠️ THAT ROUTE IS RETIRED (MOTIR-4732) AND BOTH SHAPES ARE KEPT. The workspace
// is an OVERLAY now, so there is no navigation to hold: the dialog frame is up
// on the first frame either way. What the two skeletons are FOR is unchanged —
// the canvas pane's body while its level is in flight, and the WHOLE frame while
// a work-item launch resolves its anchor over HTTP (MOTIR-4727), which is the
// window `app/(planning)/loading.tsx` used to cover for the navigation.
//
// These are the pieces that let it open FIRST:
//
//   · `PlanningCanvasSkeleton` — the canvas pane's BODY, the in-page
//     `<Suspense>` fallback the host shows while its level read is pending. It
//     fills the same `min-h-0 flex-1 overflow-hidden` box the real canvas gets,
//     so filling it costs no layout shift.
//   · `PlanningWorkspaceSkeleton` — the WHOLE frame. It was
//     `app/(planning)/loading.tsx`'s instant-loading UI; it is now what the
//     overlay renders INSIDE the dialog while the anchor read is in flight.
//
// Both are built from the REAL shipped frame rather than a stylized stand-in
// (`design/ai-chat/plan-change-conversation.mock.html` panel 2 over
// `planning-workspace.mock.html`): the skeleton composes the same
// `PlanningWorkspace` grid, repeats the back bar's and rail's own container
// classes verbatim, and sizes its blocks off the `text-sm` line box those
// surfaces render — so the skeleton and the surface it stands in for cannot
// drift apart. Colour is `--el-*` fills only, shape is element-semantic radii,
// and the whole thing is `aria-hidden` and JS-free — the shipped `loading.tsx`
// grammar (`app/(public)/explore`, `app/(authed)/settings/project/components`).

/** One pulsing placeholder block. Fill + radius through tokens only. */
function Block({ className }: { className: string }) {
  return <div className={`rounded-(--radius-control) bg-(--el-muted) ${className}`} />;
}

/**
 * The canvas pane's body while the level is still being read — the in-page
 * `<Suspense>` fallback. Mirrors what `ProjectRoadmapCanvas` draws: the
 * top-left breadcrumb and top-right search / zoom overlays, and a level of
 * node cards on the recessed board.
 */
export function PlanningCanvasSkeleton() {
  return (
    <div aria-hidden className="flex h-full w-full animate-pulse flex-col gap-6 p-6">
      {/* The canvas's own overlays — breadcrumb left, search + zoom right. */}
      <div className="flex items-start justify-between gap-4">
        <Block className="h-6 w-40" />
        <div className="flex gap-2">
          <Block className="h-8 w-8" />
          <Block className="h-8 w-8" />
          <Block className="h-8 w-8" />
        </div>
      </div>

      {/* A level of node cards, the shape a drawn level actually has. */}
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="grid w-full max-w-[46rem] grid-cols-1 gap-6 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex h-32 flex-col gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-4"
            >
              <Block className="h-4 w-16" />
              <Block className="h-4 w-full" />
              <Block className="h-4 w-2/3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The chat rail while the route is still resolving. Mirrors `PlanChangeRail`'s
 * own container, header and composer boxes — the rail needs no data of its own,
 * so this stands in only for the ROUTE transition, never mid-page.
 */
function PlanningRailSkeleton() {
  return (
    <div
      aria-hidden
      className="flex h-full min-h-0 animate-pulse flex-col border-l border-(--el-border) bg-(--el-surface)"
    >
      <div className="flex items-center gap-2 border-b border-(--el-border-soft) px-4 py-3">
        <Block className="size-2 rounded-full" />
        <Block className="h-4 w-24" />
        <Block className="ml-auto h-5 w-20" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4">
        <Block className="h-16 w-full rounded-(--radius-card)" />
        <Block className="h-9 w-3/4 rounded-(--radius-card)" />
      </div>
      <div className="border-t border-(--el-border-soft) px-4 py-4">
        <Block className="h-20 w-full rounded-(--radius-card)" />
      </div>
    </div>
  );
}

/**
 * The whole workspace frame — the overlay's own pending shape, and formerly
 * `app/(planning)/loading.tsx`'s instant-loading UI.
 * The back bar repeats the host's own container and control classes so the two
 * bars are the same height, and the panes are the same `PlanningWorkspace` grid
 * the host renders.
 */
export function PlanningWorkspaceSkeleton() {
  return (
    <PlanningWorkspace
      canvas={
        <div className="flex h-full min-h-0 flex-col bg-(--el-canvas)">
          {/* The shell's exit chrome + project crumb, in skeleton. Same
              container + control padding as the host's back bar, and `h-5`
              blocks for its `text-sm` line box, so the height matches. */}
          <div
            aria-hidden
            className="flex animate-pulse items-center gap-3 border-b border-(--el-border-soft) bg-(--el-surface) px-4 py-2"
          >
            <div className="inline-flex items-center gap-1.5 px-(--spacing-control-x) py-(--spacing-control-y)">
              <Block className="size-4" />
              <Block className="h-5 w-28" />
            </div>
            <Block className="h-5 w-40" />
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            <PlanningCanvasSkeleton />
          </div>
        </div>
      }
      chat={<PlanningRailSkeleton />}
    />
  );
}
