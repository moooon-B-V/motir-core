import { PageSkeleton } from '@/components/ui/PageSkeleton';

// THE `/pages` INDEX'S PENDING FRAME (Story MOTIR-5752 · MOTIR-7300) —
// `design/pages/design-notes.md` § State 5. Mounted by the page as its in-page
// <Suspense> fallback, AFTER the gate; never a `loading.tsx`.
//
// `header={false}`: the page paints its REAL header (heading, subtitle, New page)
// above the boundary, so the frame stands in for the list alone — five
// row-shaped blocks inside the same Card frame. Each row's line boxes match
// `PagesIndex`'s row exactly (a 20px title line, a 2px gap, an 18px meta line,
// the same vertical padding), so the list settles with no vertical shift.

const TITLE_WIDTHS = ['w-[64%]', 'w-[48%]', 'w-[72%]', 'w-[40%]', 'w-[56%]'];

export function PagesIndexFrame() {
  return (
    <PageSkeleton header={false}>
      <div
        data-testid="pages-index-frame"
        className="divide-y divide-(--el-border-soft) overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-card)"
      >
        {TITLE_WIDTHS.map((width) => (
          <div key={width} className="flex items-center gap-3 px-(--spacing-card-padding) py-2.5">
            <div className="h-[18px] w-[18px] shrink-0 rounded-(--radius-control) bg-(--el-muted)" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex h-5 items-center">
                <div className={`h-3.5 ${width} rounded-(--radius-control) bg-(--el-muted)`} />
              </div>
              <div className="flex h-[18px] items-center">
                <div className="h-3 w-40 rounded-(--radius-control) bg-(--el-muted)" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </PageSkeleton>
  );
}
