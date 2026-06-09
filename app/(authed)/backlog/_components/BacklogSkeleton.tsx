// The page-level loading skeleton for the Backlog surface (Story 4.2 · Subtask
// 4.2.3) — the 3.2.2 board-scaffold idiom: a couple of region-shaped pulsing
// blocks while the sprint list resolves. Per design/backlog/backlog.mock.html
// panel 6 (loading). Presentational, no props.

function SkeletonRegion() {
  return (
    <div
      className="rounded-(--radius-card) border border-(--el-border) bg-(--el-surface)"
      aria-hidden
    >
      <div className="flex items-center gap-2 border-b border-(--el-border) px-(--spacing-card-padding) py-(--spacing-control-y)">
        <span className="h-[18px] w-[18px] animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        <span className="h-3.5 w-24 animate-pulse rounded bg-(--el-muted)" />
        <span className="flex-1" />
        <span className="h-[18px] w-14 animate-pulse rounded-(--radius-badge) bg-(--el-muted)" />
      </div>
      <div className="flex flex-col gap-(--spacing-sm) p-(--spacing-control-x)">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-9 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        ))}
      </div>
    </div>
  );
}

export function BacklogSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" data-testid="backlog-skeleton">
      <SkeletonRegion />
      <SkeletonRegion />
    </div>
  );
}
