// The square's loading skeleton (Story 6.13 · Subtask 6.13.6 · design Panel 5).
// Shown by Next.js while the server component streams (navigation between
// rank/window/search/topic URLs). A JS-free, pure-presentational grid of pulsing
// card placeholders matching the gallery's shape. Colour via --el-* tokens;
// shape via element-semantic shape tokens.

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
