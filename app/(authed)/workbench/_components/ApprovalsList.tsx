'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { IssueListPager } from '../../items/_components/IssueListPager';
import { workbenchTabHref } from '@/lib/workbench/tab';
import { ApprovalRow, APPROVALS_GRID_TEMPLATE } from '@/components/approvals/ApprovalRow';
import { useLiveRows } from './useLiveRows';
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
  // THE LIVE RULE, for the one tab § 20's settled-row decision is about
  // (Story MOTIR-5238 · MOTIR-5242). The reset key is the "next load" § 26
  // names: a `router.refresh()` keeps the address and holds its rows, a pager
  // move changes the page and starts clean.
  const live = useLiveRows(rows, `approvals:${pagination.page}`, (row) => row.gateId);

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
          {live.rows.map((row) => (
            <ApprovalRow
              key={row.gateId}
              // ⚠️ A HELD ROW IS STILL RENDERED — § 26's rule, and the one thing
              // a naive live list gets wrong: the read returns only `awaiting`
              // gates, so a row somebody else decided is simply absent from the
              // next one, and removing it is § 20's settled rule being overturned
              // by a mechanism rather than by a decision.
              record={{ section: live.heldIds.has(row.gateId) ? 'held' : 'awaiting', row }}
              arrived={live.arrivedIds.has(row.gateId)}
            />
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
