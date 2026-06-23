// The loading skeleton for the /items tables (Subtask 2.5.3; flat variant in
// 2.5.8), per design/work-items/tree.png panel 3 + list.mock.html panel 4: the
// same column header as the real table, then shimmer rows. Purely presentational
// + static, so it's the Suspense fallback while the Server Component streams.
// Mirrors the table container chrome (rounded, bordered, header tint) so there's
// no layout shift on settle. The grid template is kept in sync with the columns.
//
// `flat` (the List view) drops the per-row indent + the chevron slot — the one
// delta between the Tree skeleton and the List skeleton (the List is un-nested).

import { useTranslations } from 'next-intl';
import { ISSUE_TITLE_MIN_TRACK } from '@/lib/issues/issueListView';

// TITLE · PRIORITY · ASSIGNEE · REPORTER · EST. · STATUS. The Title track is
// FLOORED (`minmax(10rem,1fr)`, never `minmax(0,1fr)`) and Est./Status are
// trimmed, matching the real table so there's no settle-time jump (bug
// MOTIR-1307); Due was removed as a list column.
const GRID = `minmax(${ISSUE_TITLE_MIN_TRACK},1fr) 120px 150px 150px 72px 108px`;
const HEADER_KEYS = [
  'colTitle',
  'colPriority',
  'colAssignee',
  'colReporter',
  'colEst',
  'colStatus',
] as const;

const ROWS = [0, 1, 2, 3, 4, 5, 6, 7];
// Indent (px) per row — echoes the mockup's depth-varied shimmer.
const INDENT = [0, 22, 22, 44, 44, 66, 44, 22];

function Bar({ w }: { w: number }) {
  return <span className="block h-3 rounded bg-(--el-muted)" style={{ width: w }} aria-hidden />;
}

export function IssueTreeSkeleton({ flat = false }: { flat?: boolean } = {}) {
  const t = useTranslations('issueViews');
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
          {HEADER_KEYS.map((key) => (
            <span
              key={key}
              className="text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase"
            >
              {t(key)}
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
            {/* Title — flat List drops the indent + the chevron slot. */}
            <span className="flex items-center gap-2" style={{ paddingLeft: flat ? 0 : INDENT[i] }}>
              {flat ? null : (
                <span className="h-3.5 w-3.5 shrink-0 rounded bg-(--el-muted)" aria-hidden />
              )}
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
