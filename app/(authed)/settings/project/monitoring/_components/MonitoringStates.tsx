import { Spinner } from '@/components/ui/Spinner';

// Panel 9's LOADING render (Story MOTIR-4928 · MOTIR-5262) — the room's own,
// inside the pane, never a route-level `loading.tsx`. The shipped Spinner with
// one line, because a skeleton that resolves into the empty state would draw a
// list for a room with nothing in it.
//
// Directive-free and presentational, so the server page can use it as its
// `<Suspense>` fallback without crossing into a client module.

/** The card chrome panel 9's two states share. */
export const MONITORING_STATE_CARD =
  'flex flex-col items-center gap-2.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) px-7 py-10 text-center';

export function MonitoringLoading({ label }: { label: string }) {
  return (
    <div className={MONITORING_STATE_CARD}>
      <span className="inline-flex items-center gap-2.5 font-sans text-sm text-(--el-text-secondary)">
        <Spinner size="sm" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
}
