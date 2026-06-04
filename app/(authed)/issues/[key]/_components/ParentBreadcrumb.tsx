import { Fragment } from 'react';
import Link from 'next/link';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';

// The parent breadcrumb on the issue detail page (Story 2.4 · Subtask 2.4.3),
// per the mockup `design/work-items/detail.png`: the eyebrow row reads
// `[type] PROD-N · [type] Epic: <title>` — the current item's identifier
// (rendered by 2.4.1's header) followed by its ANCESTOR chain. This component
// renders only the chain (the `· [icon] <Type>: <title>` segments) so it slots
// in right after the identifier. Ancestors arrive ordered root→self, so the
// epic reads first and the immediate parent last, matching the lineage a nested
// subtask (Subtask → Task → Story → Epic) walks up to.
//
// A top-level item has no ancestors → renders nothing (the AC's "no breadcrumb"
// case). Each segment is a plain `next/link` to that ancestor's own detail page
// (`/issues/[key]`) — the tree recursion the breadcrumb implies — so the chain
// is keyboard-navigable as a sequence of links. Wrapped in a `<nav>` landmark
// with an accessible name so assistive tech announces it as navigation.

export function ParentBreadcrumb({ ancestors }: { ancestors: WorkItemSummaryDto[] }) {
  if (ancestors.length === 0) return null;

  return (
    <nav
      aria-label="Parent issues"
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
    >
      {ancestors.map((ancestor) => {
        const meta = ISSUE_TYPE_META[ancestor.kind];
        return (
          <Fragment key={ancestor.id}>
            <span className="text-(--el-text-secondary)" aria-hidden>
              ·
            </span>
            <Link
              href={`/issues/${ancestor.identifier}`}
              className="text-(--el-text-muted) hover:text-(--el-text) flex min-w-0 items-center gap-1 rounded font-sans text-sm hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <IssueTypeIcon type={ancestor.kind} className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {meta.label}: {ancestor.title}
              </span>
            </Link>
          </Fragment>
        );
      })}
    </nav>
  );
}
