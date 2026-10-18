import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { ReportHelpRegion, ReportHelpToggle, type ReportHelpId } from './ReportHelp';

// Shared chrome for the two report pages (Story 6.3 · Subtask 6.3.6) — the
// back-to-Reports link + the report Card (breadcrumb + serif title + config
// sub-line + body), per design/reports/dashboard.mock.html panel 7. Server
// component (no state); the sub-line is rebuilt on every URL-driven re-render,
// so it always tracks the active config.
//
// The page fills the content region and the body sits in the design's
// `.report-card` (the `Card` primitive). The chart's HEIGHT is bounded by the
// chart primitives' page mode (`fit="page"`, `clamp(280px, 44vh, 420px)`), not by
// a width cap: the old `max-w-[48rem]` column (MOTIR-449) kept a responsive chart
// from growing taller as it grew wider, and page mode now holds the height
// itself, so the cap is gone. Never reach for a NAMED `max-w-*` utility here —
// this project's Tailwind `@theme` clears the named container scale and
// `max-w-3xl` collapses the page to a ~40px column.

export function ReportPageChrome({
  backLabel,
  backHref = '/reports',
  crumb,
  title,
  subLine,
  help,
  children,
}: {
  backLabel: string;
  /** Where the back link goes; the Reports hub unless a page says otherwise. */
  backHref?: string;
  /** The breadcrumb trail's leading label (e.g. "Reports"). */
  crumb: string;
  title: string;
  /** The config summary line, e.g. "Motir · Weekly · last 90 days · per-period". */
  subLine: string;
  /** Which report's help text this page carries (Story MOTIR-8919). Required, so a
   * page cannot be added without saying what it shows. */
  help: ReportHelpId;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col gap-4">
      <Link
        href={backHref}
        className="inline-flex w-fit items-center gap-1 text-sm text-(--el-text-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {backLabel}
      </Link>
      <Card>
        <header className="mb-5 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-1 text-xs text-(--el-text-muted)">
                <span>{crumb}</span>
                <span aria-hidden>/</span>
                <span>{title}</span>
              </div>
              <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{title}</h1>
              <p className="text-sm text-(--el-text-muted)">{subLine}</p>
            </div>
            <ReportHelpToggle report={help} />
          </div>
          <ReportHelpRegion report={help} />
        </header>
        {children}
      </Card>
    </div>
  );
}
