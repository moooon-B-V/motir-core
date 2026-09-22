'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { IssueListPager } from '../../items/_components/IssueListPager';
import {
  ApprovalRow,
  APPROVALS_FULL_VIEW_GRID_TEMPLATE,
  APPROVALS_GRID_TEMPLATE,
} from '@/components/approvals/ApprovalRow';
import type { ApprovalRecordsPageDto } from '@/lib/dto/approvalGate';

// THE APPROVAL RECORDS ROOM's LIST (Story MOTIR-5299 · MOTIR-5302), built to
// `design/approvals/approvals-room.mock.html` and `design/approvals/design-notes.md`.
//
// ⚠️ IT RENDERS WHAT THE READ DECIDED AND DECIDES NOTHING ITSELF. The sections,
// their order and their totals are `approvalGatesService.listRecords`'s DTO, and the
// PERSON column is keyed on the DTO's `fullView` — a fact ABOUT the answer the read
// returned. This island never asks for a permission: a surface that re-checked the
// key would be a second copy of the scope decision, and the two could disagree.
//
// ⚠️ ONE ROW. Every row is `components/approvals/ApprovalRow.tsx`, the row the
// Workbench's To-approve tab renders. The room adds CONDITIONAL elements of that row
// (the decided record, the person cell) and never a second row.
//
// ⚠️ ONE TABLE, TWO SECTIONS. The sections are two header rows in one card, not two
// tables (`design/approvals` § The grid), and ONE pager windows the concatenation.
// A page holding rows of only one section still draws both headings once there is a
// row anywhere, with `0` in the empty section's chip and its one-line empty state.

/** The room's page address — the only query this list writes besides the overlay's. */
export function approvalRecordsHref(page: number): string {
  return page > 1 ? `/approvals?page=${page}` : '/approvals';
}

function SectionHeader({
  title,
  total,
  columns,
  gridTemplate,
}: {
  title: string;
  total: number;
  columns: string[];
  gridTemplate: string;
}) {
  return (
    <div role="rowgroup">
      <div
        role="row"
        className="flex h-10 items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) pr-4 pl-4 md:grid"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <div role="columnheader" className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[11px] font-semibold tracking-wider text-(--el-text) uppercase">
            {title}
          </span>
          <span className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-(--radius-badge) bg-(--el-count-bg) px-(--spacing-chip-x) text-[11px] font-semibold text-(--el-count-text)">
            {total}
          </span>
        </div>
        {/* The column labels ride in the same band, and — like the tab's column
            header — are hidden below `md`, where the grid they label does not exist. */}
        {columns.map((c, i) => (
          <div
            key={c || `c${i}`}
            role="columnheader"
            className="hidden min-w-0 items-center md:flex"
          >
            <span className="truncate text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
              {c}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionEmptyLine({ children }: { children: ReactNode }) {
  return (
    <div role="row" className="border-b border-(--el-border) px-4 py-3 last:border-b-0">
      <p role="cell" className="text-sm text-(--el-text-secondary)">
        {children}
      </p>
    </div>
  );
}

export function ApprovalRecordsList({ records }: { records: ApprovalRecordsPageDto }) {
  const t = useTranslations('approvalRecords');
  const router = useRouter();
  const { fullView, sections } = records;
  const gridTemplate = fullView ? APPROVALS_FULL_VIEW_GRID_TEMPLATE : APPROVALS_GRID_TEMPLATE;

  // A page that starts inside the decided half draws only the Decided heading
  // (`design/approvals` § The ORDER): the awaiting section's rows all sit on
  // earlier pages. Otherwise both headings render, an empty one with its line.
  const awaitingOnEarlierPages =
    sections.awaiting.items.length === 0 &&
    sections.awaiting.total > 0 &&
    (records.page - 1) * records.pageSize >= sections.awaiting.total;
  // …and a page that ends inside the awaiting half draws only its heading.
  const decidedOnLaterPages =
    sections.decided.items.length === 0 &&
    sections.decided.total > 0 &&
    sections.awaiting.items.length > 0;

  return (
    <div
      data-surface="card"
      className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
    >
      <div role="table" aria-label={t('tableLabel')} className="w-full text-sm">
        {awaitingOnEarlierPages ? null : (
          <>
            <SectionHeader
              title={t('sections.awaiting')}
              total={sections.awaiting.total}
              gridTemplate={gridTemplate}
              columns={[
                t('columns.details'),
                t('columns.waited'),
                ...(fullView ? [t('columns.askedOf')] : []),
                '',
              ]}
            />
            <div role="rowgroup" data-testid="approval-records-awaiting">
              {sections.awaiting.total === 0 ? (
                <SectionEmptyLine>
                  {fullView ? t('empty.awaitingFull') : t('empty.awaitingOwn')}
                </SectionEmptyLine>
              ) : (
                sections.awaiting.items.map((row) => (
                  <ApprovalRow
                    key={row.gateId}
                    record={{ section: 'awaiting', row }}
                    gridTemplate={gridTemplate}
                    person={
                      fullView
                        ? { label: t('columns.askedOf'), value: row.routedToName ?? t('noOne') }
                        : undefined
                    }
                  />
                ))
              )}
            </div>
          </>
        )}
        {decidedOnLaterPages ? null : (
          <>
            <SectionHeader
              title={t('sections.decided')}
              total={sections.decided.total}
              gridTemplate={gridTemplate}
              columns={[
                t('columns.details'),
                t('columns.decided'),
                ...(fullView ? [t('columns.decidedBy')] : []),
                '',
              ]}
            />
            <div role="rowgroup" data-testid="approval-records-decided">
              {sections.decided.total === 0 ? (
                <SectionEmptyLine>
                  {fullView ? t('empty.decidedFull') : t('empty.decidedOwn')}
                </SectionEmptyLine>
              ) : (
                sections.decided.items.map((row) => (
                  <ApprovalRow
                    key={row.gateId}
                    record={{ section: 'decided', row }}
                    gridTemplate={gridTemplate}
                    person={
                      fullView
                        ? {
                            label: t('columns.decidedBy'),
                            // WHO and WHERE in one cell (MOTIR-5599; design § 23, Panel G7).
                            // A decision made on GitHub says so here, because the room is
                            // where an auditor reads decisions side by side and the door
                            // they came through is the thing that distinguishes them.
                            value:
                              row.decisionSource === 'github'
                                ? t('decidedByOnGithub', {
                                    label: row.decidedByLabel ?? t('noOne'),
                                  })
                                : (row.decidedByLabel ?? t('noOne')),
                          }
                        : undefined
                    }
                  />
                ))
              )}
            </div>
          </>
        )}
      </div>
      {/* The shipped pager, composed unchanged. Its denominator is the read's
          `total` — both section totals — so it cannot disagree with the rows. */}
      <IssueListPager
        total={records.total}
        page={records.page}
        pageSize={records.pageSize}
        onPage={(page) => router.push(approvalRecordsHref(page))}
      />
    </div>
  );
}
