import { PageSkeleton } from '@/components/ui/PageSkeleton';

// THE `/pages` TREE'S PENDING FRAME (Story MOTIR-5752 · MOTIR-7300; tree-shaped
// since Story MOTIR-5753 · MOTIR-7373) — `design/pages/pages--tree.mock.html`
// panel 5, "First level". Mounted by the page as its in-page <Suspense>
// fallback, AFTER the gate; never a `loading.tsx`.
//
// `header={false}`: the page paints its REAL header (heading, subtitle, New page)
// above the boundary, so the frame stands in for the tree alone — five
// row-shaped blocks inside the same frame. Each row is a tree row's box exactly
// (40px, the first level's indent, the 16px chevron slot, a 16px glyph, a title
// bar), so the tree settles with no vertical shift. `PageSkeleton` announces the
// wait once, with the shipped `shell.pageLoading`.

const TITLE_WIDTHS = ['w-[140px]', 'w-[110px]', 'w-[200px]', 'w-[170px]', 'w-[90px]'];

export function PagesIndexFrame() {
  return (
    <PageSkeleton header={false}>
      <div
        data-testid="pages-index-frame"
        className="divide-y divide-(--el-border-soft) overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-card)"
      >
        {TITLE_WIDTHS.map((width) => (
          <div key={width} className="flex h-10 items-center gap-2 pr-2 pl-[28px]">
            <div className="h-4 w-4 shrink-0" />
            <div className="h-4 w-4 shrink-0 rounded-(--radius-control) bg-(--el-muted)" />
            <div className={`h-3 ${width} rounded-(--radius-control) bg-(--el-muted)`} />
          </div>
        ))}
      </div>
    </PageSkeleton>
  );
}
