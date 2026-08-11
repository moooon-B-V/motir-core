'use client';

import Link from 'next/link';
import { Bot } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import { Avatar, StatusValue } from '../../items/_components/issueCellPrimitives';
import { usePeekRowClick } from '../../items/_components/IssueQuickView';
import type { HomeRowView } from './homeRows';

// The Home list (Story MOTIR-2649 · Subtask MOTIR-2653, per
// design/home/design-notes.md §Layout) — My work and Watching render the SAME
// list; only the rows differ.
//
// ⚠️ It composes the shipped `/items` CELLS rather than the shipped `/items`
// ROW, and the design measured why. The `/items` grid is nine columns with a
// minimum width of 1204px; the shell gives a page 896px at a 1200 viewport and
// 976 at 1280, so that row does not fit at any common laptop width (which is
// the known MOTIR-1307 clipping — Home must not inherit it). Home's set is
// `Title · Project · Your role · Assignee · Status`, minimum 754px, and it uses
// `IssueTypeIcon`, the row `Avatar` and `StatusValue` unchanged, so a cell
// renders identically here and on /items.
//
// Two cells exist only here: the PROJECT chip (a project-scoped list never has
// to say which project it is in) and YOUR ROLE (the merged assigned-OR-reported
// read is the story's central decision, and this is the only place a reader can
// see the dedupe hold — a `Both` row appears exactly once).
//
// Below `md` the row COLLAPSES to two lines rather than clipping: the meta
// wrapper is a wrapping flex row at narrow widths and `display: contents` at
// `md`, so its four cells become grid children of the row itself. One DOM tree,
// two arrangements — no duplicated markup to drift.

/** The Home column set. See design-notes §Measurements for the numbers. */
const GRID_TEMPLATE = 'minmax(10rem,1fr) 116px 96px 140px 108px';

/** The whole-row navigation + peek link, stretched behind the cells. */
function RowLink({ row, label }: { row: HomeRowView; label: string }) {
  const onPeekClick = usePeekRowClick();
  return (
    <Link
      href={`/items/${row.identifier}`}
      aria-label={label}
      onClick={(e) => onPeekClick(e, row.identifier)}
      className="absolute inset-0 z-0 focus:outline-none"
    />
  );
}

/** The assignee cell — the shipped row `Avatar`, badged when an agent is on it. */
function AssigneeCell({ row }: { row: HomeRowView }) {
  const t = useTranslations('home');
  if (!row.assigneeName) {
    return <span className="text-(--el-text-muted)">{t('row.unassigned')}</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      {row.agent ? (
        // The agent badge — the same avatar-with-glyph-badge composition the
        // shipped NotificationRow uses, so the vocabulary is borrowed rather
        // than invented. The glyph is `Bot`, which is what the shipped
        // ExecutorIndicator already shows for `executor: coding_agent`, so the
        // row and the detail rail agree. Decorative: the sr-only span carries
        // the meaning.
        <span className="relative shrink-0">
          <Avatar name={row.assigneeName} />
          <span
            aria-hidden
            className="absolute -right-0.5 -bottom-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-(--el-executor-agent) text-(--el-accent-text) ring-2 ring-(--el-page-bg)"
          >
            <Bot className="h-2.5 w-2.5" />
          </span>
        </span>
      ) : (
        <Avatar name={row.assigneeName} />
      )}
      <span className="truncate text-(--el-text-secondary)">{row.assigneeName}</span>
      {row.agent ? <span className="sr-only">{t('row.agentExecuting')}</span> : null}
    </span>
  );
}

function HomeRow({ row }: { row: HomeRowView }) {
  const t = useTranslations('home');
  return (
    <div
      role="row"
      data-testid={`home-row-${row.identifier}`}
      className={cn(
        'group relative flex flex-col gap-1 border-b border-(--el-border) px-4 py-2.5 last:border-b-0',
        'hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2',
        'md:grid md:h-11 md:items-center md:gap-x-4 md:gap-y-0 md:py-0 md:pr-7 md:pl-4',
      )}
      style={{ gridTemplateColumns: GRID_TEMPLATE }}
    >
      <div role="cell" className="flex min-w-0 items-center">
        <RowLink row={row} label={`${row.identifier} ${row.title}`} />
        <span className="flex min-w-0 items-center gap-2">
          <IssueTypeIcon type={row.kind} className="h-4 w-4 shrink-0" />
          <span className="shrink-0 font-mono text-xs text-(--el-text-muted)">
            {row.identifier}
          </span>
          <span className="min-w-0 flex-1 truncate text-(--el-text) group-hover:underline">
            {row.title}
          </span>
        </span>
      </div>

      {/* The meta line. `md:contents` promotes these four to grid children of
          the row at `md`; below it they wrap as one indented flex line. */}
      <div role="presentation" className="flex flex-wrap items-center gap-2 pl-6 md:contents">
        <div role="cell" className="flex min-w-0 items-center">
          <Pill tone="neutral" className="min-w-0">
            <span className="truncate">{row.projectName}</span>
          </Pill>
        </div>
        <div role="cell" className="flex min-w-0 items-center">
          <span
            className={cn(
              'truncate text-xs',
              // `Both` takes weight as well as ink — the non-colour redundant
              // cue (finding #35), and the one value worth spotting.
              row.role === 'both'
                ? 'font-medium text-(--el-text-strong)'
                : 'text-(--el-text-secondary)',
            )}
          >
            {t(`row.role.${row.role}`)}
          </span>
        </div>
        <div role="cell" className="flex min-w-0 items-center">
          <AssigneeCell row={row} />
        </div>
        <div role="cell" className="flex min-w-0 items-center">
          <StatusValue category={row.statusCategory} label={row.statusLabel} />
        </div>
      </div>
    </div>
  );
}

export function HomeList({ rows, label }: { rows: HomeRowView[]; label: string }) {
  const t = useTranslations('home');
  const columns = [
    t('columns.title'),
    t('columns.project'),
    t('columns.role'),
    t('columns.assignee'),
    t('columns.status'),
  ];
  return (
    <div
      data-surface="card"
      className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
    >
      <div role="table" aria-label={label} className="w-full text-sm">
        {/* The column header is hidden below `md`, where there are no columns
            to head — the stacked row labels itself. */}
        <div role="rowgroup" className="hidden md:block">
          <div
            role="row"
            className="sticky top-0 z-20 grid items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) pr-7 pl-4"
            style={{ gridTemplateColumns: GRID_TEMPLATE, height: 40 }}
          >
            {columns.map((c) => (
              <div key={c} role="columnheader" className="flex min-w-0 items-center">
                <span className="truncate text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
                  {c}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div role="rowgroup">
          {rows.map((row) => (
            <HomeRow key={row.id} row={row} />
          ))}
        </div>
      </div>
    </div>
  );
}
