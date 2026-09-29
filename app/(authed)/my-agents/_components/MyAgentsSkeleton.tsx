import { Plus } from 'lucide-react';

/** Panel 7's wait: the page header, then skeleton lines in a card. */
export function MyAgentsSkeleton({
  title,
  subtitle,
  newAgent,
}: {
  title: string;
  subtitle: string;
  newAgent: string;
}) {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{title}</h1>
          <p className="text-sm text-(--el-text-secondary)">{subtitle}</p>
        </div>
        <span
          aria-hidden="true"
          className="inline-flex h-(--height-btn-md) items-center gap-2 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) text-sm text-(--el-accent-text) opacity-60"
        >
          <Plus className="size-4" />
          {newAgent}
        </span>
      </header>
      <div className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding)">
        <div className="h-3 w-2/5 animate-pulse rounded-full bg-(--el-muted)" />
        <div className="h-3 w-3/4 animate-pulse rounded-full bg-(--el-muted)" />
        <div className="h-3 w-1/2 animate-pulse rounded-full bg-(--el-muted)" />
      </div>
    </div>
  );
}
