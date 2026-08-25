// The square's loading skeleton (Story 6.13 · Subtask 6.13.6 · design Panel 5).
// Shown by Next.js while the server component streams (navigation between
// rank/window/search URLs). A JS-free, pure-presentational grid of pulsing
// card placeholders matching the gallery's shape. Colour via --el-* tokens;
// shape via element-semantic shape tokens.
//
// ⚠️ IT LIVES IN THE `(square)` ROUTE GROUP ON PURPOSE — DO NOT HOIST IT BACK UP
// TO `explore/` (MOTIR-3491). A `loading.tsx` fallback can render as soon as its
// ancestor layouts resolve, which is BEFORE the page function runs; that flushes
// the response head and fixes the status at 200. At `explore/` this boundary was
// an ancestor of `explore/topic/[slug]/page.tsx`, whose `notFound()` for an
// unknown topic then rendered the not-found BODY under a 200 — measured, on a
// production build: `/explore/topic/definitely-not-a-real-topic-xyz` answered
// 200, and 404 once the boundary stopped being its ancestor.
//
// The group is what keeps BOTH properties: `(square)` contains only this page,
// which decides nothing, so the frame still covers `/explore`; and `topic/[slug]`
// sits outside the group, so its status is settled before anything is flushed.
// A page that must both 404 and stream uses an in-page <Suspense> AFTER its own
// gate instead. See `motir-core/CLAUDE.md` § *A `loading.tsx` may NOT sit above a
// route that decides existence*, and the repo-wide guard in
// `tests/navigation/loading-boundary-guard.test.ts`.

export default function ExploreLoading() {
  return (
    <div aria-hidden className="animate-pulse">
      <div className="h-56 rounded-(--radius-card) bg-(--el-surface-soft)" />
      <div className="mt-8 flex gap-2">
        <div className="h-9 w-48 rounded-(--radius-btn) bg-(--el-surface-soft)" />
        <div className="h-9 w-40 rounded-(--radius-btn) bg-(--el-surface-soft)" />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-44 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface)"
          />
        ))}
      </div>
    </div>
  );
}
