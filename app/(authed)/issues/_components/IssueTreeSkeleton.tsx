// The loading skeleton for the /issues tree-table (Subtask 2.5.3), per
// design/work-items/tree.png panel 3: the same column header as the real table,
// then shimmer rows. Purely presentational + static, so it's the Suspense
// fallback while the Server Component streams the tree. Mirrors the TreeTable
// container chrome (rounded, bordered, header tint) so there's no layout shift
// on settle. The grid template is kept in sync with IssueTreeTable's columns.

// TITLE · PRIORITY · ASSIGNEE · REPORTER · DUE · EST. · STATUS.
const GRID = 'minmax(0,1fr) 120px 150px 150px 120px 90px 130px';
const HEADERS = ['Title', 'Priority', 'Assignee', 'Reporter', 'Due', 'Est.', 'Status'];

const ROWS = [0, 1, 2, 3, 4, 5, 6, 7];
// Indent (px) per row — echoes the mockup's depth-varied shimmer.
const INDENT = [0, 22, 22, 44, 44, 66, 44, 22];

function Bar({ w }: { w: number }) {
  return <span className="block h-3 rounded bg-(--el-muted)" style={{ width: w }} aria-hidden />;
}

export function IssueTreeSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-xl border border-(--el-border)"
      aria-hidden
      data-testid="issue-tree-skeleton"
    >
      <div className="w-full animate-pulse text-sm">
        {/* Header — matches the real table's columns. */}
        <div
          className="grid items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) pr-7 pl-4"
          style={{ gridTemplateColumns: GRID, height: 40 }}
        >
          {HEADERS.map((h) => (
            <span
              key={h}
              className="text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase"
            >
              {h}
            </span>
          ))}
        </div>

        {/* Shimmer rows. */}
        {ROWS.map((i) => (
          <div
            key={i}
            className="grid items-center gap-x-4 border-b border-(--el-border) pr-7 pl-4 last:border-b-0"
            style={{ gridTemplateColumns: GRID, height: 40 }}
          >
            {/* Title */}
            <span className="flex items-center gap-2" style={{ paddingLeft: INDENT[i] }}>
              <span className="h-3.5 w-3.5 shrink-0 rounded bg-(--el-muted)" aria-hidden />
              <span className="h-4 w-4 shrink-0 rounded bg-(--el-muted)" aria-hidden />
              <Bar w={56} />
              <Bar w={140 + (i % 3) * 50} />
            </span>
            {/* Priority */}
            <span className="block h-5 w-16 rounded-full bg-(--el-muted)" aria-hidden />
            {/* Assignee */}
            <span className="flex items-center gap-2">
              <span
                className="h-[22px] w-[22px] shrink-0 rounded-full bg-(--el-muted)"
                aria-hidden
              />
              <Bar w={64} />
            </span>
            {/* Reporter */}
            <span className="flex items-center gap-2">
              <span
                className="h-[22px] w-[22px] shrink-0 rounded-full bg-(--el-muted)"
                aria-hidden
              />
              <Bar w={64} />
            </span>
            {/* Due */}
            <Bar w={64} />
            {/* Estimate (right-aligned) */}
            <span className="flex justify-end">
              <Bar w={36} />
            </span>
            {/* Status */}
            <span className="block h-5 w-20 rounded-full bg-(--el-muted)" aria-hidden />
          </div>
        ))}
      </div>
    </div>
  );
}
