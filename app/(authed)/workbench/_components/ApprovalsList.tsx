'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ApprovalRow, APPROVALS_GRID_TEMPLATE } from '@/components/approvals/ApprovalRow';
import { useLiveRows } from './useLiveRows';
import type { ApprovalQueueRowDto } from '@/lib/dto/approvalGate';
import type { ReactNode } from 'react';

// THE APPROVALS TAB'S LIST (Story MOTIR-4879 · Subtask MOTIR-4794), built to
// `design/workbench/approvals-row.mock.html` and its § 20 in
// `design/workbench/design-notes.md` — AS AMENDED by § 22 (Story MOTIR-5214).
//
// ⚠️ THE ROW IS `components/approvals/ApprovalRow.tsx` (extracted by MOTIR-5302), the
// ONE approvals row the Workbench and the Approval records room both render. Its
// header carries the row's contract: it OPENS the approval overlay, it holds no
// frame and no decide path, and a row decided in the overlay SETTLES in place
// rather than vanishing. This list is the tab's table and its header.
//
// ⚠️ NO PAGER (Story MOTIR-5996 · MOTIR-5998; `design/workbench/design-notes.md`
// § 28, DECISION 5). The tab lists every approval routed to its reader: one
// person's queue is short, and a pager on a short list only hides its oldest
// questions behind a click nobody makes. The read is bounded by the service's
// ceiling, and when that bites, ONE line under the last row says so and points at
// the Approvals room, which lists every one with its own pager.

const GRID_TEMPLATE = APPROVALS_GRID_TEMPLATE;

export function ApprovalsList({
  rows,
  label,
  ceiling,
  empty,
}: {
  rows: ApprovalQueueRowDto[];
  label: string;
  /**
   * Set when the read's ceiling CUT the set: how many rows are shown and how many
   * are waiting. `null` — the ordinary case — draws nothing.
   */
  ceiling: { shown: number; total: number } | null;
  /**
   * What an empty tab shows — rendered HERE rather than instead of this
   * component (Story MOTIR-5238 · MOTIR-5245's E2E finding).
   *
   * ⚠️ THE MOST VISIBLE ARRIVAL IS INTO AN EMPTY TAB, and it was the one
   * arrival that could never be marked. `useLiveRows` answers *what arrived*
   * from the set this component saw LAST — so a component that does not exist
   * until the first row lands has no last set, mounts fresh, and by its own
   * correct rule marks nothing (`arrivedRowIds`: "a reader who has just landed
   * has had nothing arrive under them"). A reader watching *Nothing is waiting
   * on your approval* is the reader most obviously LOOKING, and § 26 Panel 1
   * draws exactly that moment. So the branch moves inside: the component is
   * mounted the whole time and the empty state is one of the things it can
   * draw, which makes the row that replaces it an arrival like any other.
   */
  empty: ReactNode;
}) {
  const t = useTranslations('workbench.approvals');
  // THE LIVE RULE, for the one tab § 20's settled-row decision is about
  // (Story MOTIR-5238 · MOTIR-5242). The reset key is the "next load" § 26
  // names: a `router.refresh()` keeps the address and holds its rows. With no
  // pager there is one window, so the key is constant (MOTIR-5998).
  const live = useLiveRows(rows, 'approvals', (row) => row.gateId);

  // ⚠️ `live.rows`, NOT `rows` — a HELD row keeps the list non-empty, so a queue
  // the reader has just emptied does not flip to the empty state underneath the
  // receipt of the decision they have only just made (§ 20, § 26).
  if (live.rows.length === 0) return <>{empty}</>;

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
      {ceiling === null ? null : (
        /* THE CEILING LINE (§ 28, DECISION 5) — a note, never an alert: nothing is
           wrong, the list is merely long. The strip's count stays the true total,
           which is why this line has to say how many are shown. */
        <div
          role="note"
          className="flex flex-wrap items-center gap-x-1 border-t border-(--el-border) bg-(--el-surface-soft) px-4 py-2.5 text-xs text-(--el-text-secondary)"
        >
          {t.rich('ceiling', {
            shown: ceiling.shown,
            total: ceiling.total,
            link: (chunks) => (
              <Link
                href="/approvals"
                className="font-medium text-(--el-link) hover:underline focus-visible:underline focus-visible:outline-none"
              >
                {chunks}
              </Link>
            ),
          })}
        </div>
      )}
    </div>
  );
}
