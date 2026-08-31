// The runs index's WAIT (Story MOTIR-1789 · MOTIR-3923).
//
// ⚠️ THE WAIT AND THE FAILURE ARE SEPARATE FACES — `design/runs/design-notes.md`
// § `/runs` panel 5. *We could not load this* and *nothing has run* are opposite
// facts and must never share one surface; this is only the first.
//
// It keeps the page's SHAPE — two headed sections, the same table chrome — so
// the arrival does not move anything. A frame that lays out differently from the
// thing it precedes makes the real content look like a correction.
export function RunsIndexSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      {[0, 1].map((section) => (
        <section key={section} className="flex flex-col gap-2">
          <div className="h-4 w-28 rounded-(--radius-badge) bg-(--el-muted)" />
          <div className="overflow-hidden rounded-(--radius-card) border border-(--el-border)">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="flex items-center gap-4 border-b border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y) last:border-b-0"
              >
                <div className="h-3 w-40 rounded-(--radius-badge) bg-(--el-muted)" />
                <div className="h-3 w-24 rounded-(--radius-badge) bg-(--el-muted)" />
                <div className="ml-auto h-3 w-20 rounded-(--radius-badge) bg-(--el-muted)" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
