import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

// Shared chrome for the two report pages (Story 6.3 · Subtask 6.3.6) — the
// back-to-Reports link + breadcrumb + serif title + the config sub-line, per
// design/reports/dashboard.mock.html panel 7. Server component (no state); the
// sub-line is rebuilt on every URL-driven re-render, so it always tracks the
// active config.

export function ReportPageChrome({
  backLabel,
  crumb,
  title,
  subLine,
  children,
}: {
  backLabel: string;
  /** The breadcrumb trail's leading label (e.g. "Reports"). */
  crumb: string;
  title: string;
  /** The config summary line, e.g. "Motir · Weekly · last 90 days · per-period". */
  subLine: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/reports"
          className="inline-flex w-fit items-center gap-1 text-sm text-(--el-text-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {backLabel}
        </Link>
        <div className="flex items-center gap-1 text-xs text-(--el-text-muted)">
          <span>{crumb}</span>
          <span aria-hidden>/</span>
          <span>{title}</span>
        </div>
        <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{title}</h1>
        <p className="text-sm text-(--el-text-muted)">{subLine}</p>
      </header>
      {children}
    </div>
  );
}
