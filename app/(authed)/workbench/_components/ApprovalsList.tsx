'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { IssueListPager } from '../../items/_components/IssueListPager';
import { workbenchTabHref } from '@/lib/workbench/tab';
import { ApprovalRow, APPROVALS_GRID_TEMPLATE } from '@/components/approvals/ApprovalRow';
import type { ApprovalQueueRowDto } from '@/lib/dto/approvalGate';

// THE APPROVALS TAB'S LIST (Story MOTIR-4879 · Subtask MOTIR-4794), built to
// `design/workbench/approvals-row.mock.html` and its § 20 in
// `design/workbench/design-notes.md` — AS AMENDED by § 22 (Story MOTIR-5214).
//
// ⚠️ THE ROW IS `components/approvals/ApprovalRow.tsx` (extracted by MOTIR-5302), the
// ONE approvals row the Workbench and the Approval records room both render. Its
// header carries the row's contract: it OPENS the approval overlay, it holds no
// frame and no decide path, and a row decided in the overlay SETTLES in place
// rather than vanishing. This list is the tab's table, its header and its pager.

const GRID_TEMPLATE = APPROVALS_GRID_TEMPLATE;

export function ApprovalsList({
  rows,
  label,
  pagination,
}: {
  rows: ApprovalQueueRowDto[];
  label: string;
  pagination: { total: number; page: number; pageSize: number };
}) {
  const t = useTranslations('workbench.approvals');
  const router = useRouter();

  return (
    <div
      data-surface="card"
      className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
    >
      <div role="table" aria-label={label} className="w-full text-sm">
        {/* Hidden below `md`: it labels a grid that does not exist at that width,
            and a header reading "Work item" above something that is not a column
            is worse than no header (design-notes § 20). */}
        <div role="rowgroup" className="hidden md:block">
          <div
            role="row"
            className="sticky top-0 z-20 grid items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) pr-4 pl-4"
            style={{ gridTemplateColumns: GRID_TEMPLATE, height: 40 }}
          >
            {[t('columns.subject'), t('columns.workItem'), t('columns.waited'), ''].map((c, i) => (
              <div key={c || `c${i}`} role="columnheader" className="flex min-w-0 items-center">
                <span className="truncate text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
                  {c}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div role="rowgroup">
          {rows.map((row) => (
            <ApprovalRow key={row.gateId} record={{ section: 'awaiting', row }} />
          ))}
        </div>
      </div>
      {/* The shipped pager, inherited unchanged — `design/workbench/design-notes.md`
          records that this tab gets it "for free the moment MOTIR-4794 renders
          rows into the shared list". */}
      <IssueListPager
        total={pagination.total}
        page={pagination.page}
        pageSize={pagination.pageSize}
        onPage={(page) => router.push(workbenchTabHref('approvals', page))}
      />
    </div>
  );
}
