import Link from 'next/link';
import { Link2 } from 'lucide-react';
import type { ReadinessVerdictDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkflowDto, StatusCategoryDto } from '@/lib/dto/workflows';
import { ContentSectionCard } from './ContentSectionCard';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';

// The relationships panel on the issue detail page (Story 2.4 · Subtask 2.4.5),
// per `design/work-items/relationships.mock.html`: a LEFT-column section card
// (sibling of Description / Explanation / Activity, after Explanation), NOT a
// rail field-box — relationships is a grouped, multi-row list that needs the
// content width. READ-ONLY (creating/removing links is Epic 5 collaboration; the
// muted "Manage in Epic 5" header note is the documented extension slot).
//
// At the top sits the ready/blocked banner (`ReadinessBadge`), fed the service
// `readiness` verdict — its first PRODUCTION wiring (2.2.6 / finding #21). It
// renders only when the item HAS blockers (a "blocked by" in-edge); an item
// nothing blocks has no readiness signal to show. Below it, the work_item_link
// edges (1.4.3) group by kind — blocked-by / blocks / relates-to / duplicates /
// clones — each linked item a navigable row (type icon · identifier · title ·
// status pill), mirroring the 2.4.3 ChildList row grammar. No links at all → a
// muted empty state, never blank.

const STATUS_TONE: Record<StatusCategoryDto, NonNullable<PillProps['status']>> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

export interface RelationshipsPanelProps {
  blockedBy: WorkItemSummaryDto[];
  blocks: WorkItemSummaryDto[];
  relatesTo: WorkItemSummaryDto[];
  duplicates: WorkItemSummaryDto[];
  clones: WorkItemSummaryDto[];
  readiness: ReadinessVerdictDto;
  /** The item's project workflow — classifies a linked status into a Pill tone. */
  workflow: WorkflowDto;
}

// One linked item: a row navigating to its own detail page. The identifier and
// title share an inline text baseline (they're inline siblings inside one
// truncating block), while the icon / dot / pill are vertically centered — the
// alignment the design specifies. A status the bundled workflow knows renders as
// a lifecycle Pill; a cross-project status it doesn't classify falls back to a
// neutral chip (the link target can live in another project).
function LinkRow({
  item,
  workflow,
  isOpenBlocker,
}: {
  item: WorkItemSummaryDto;
  workflow: WorkflowDto;
  isOpenBlocker?: boolean;
}) {
  const statusMeta = workflow.statuses.find((s) => s.key === item.status);
  return (
    <li>
      <Link
        href={`/issues/${item.identifier}`}
        className="hover:bg-(--el-surface) group flex items-center gap-2 rounded-md px-2 py-1.5 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {isOpenBlocker ? (
          <span
            className="bg-(--el-warning) h-1.5 w-1.5 shrink-0 rounded-full"
            aria-hidden
            title="Open blocker"
          />
        ) : null}
        <IssueTypeIcon type={item.kind} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-(--el-text-muted) font-mono text-xs">{item.identifier}</span>
          <span className="text-(--el-text) ml-2 font-sans text-sm group-hover:underline">
            {item.title}
          </span>
        </span>
        {statusMeta ? (
          <Pill status={STATUS_TONE[statusMeta.category]} className="shrink-0">
            {statusMeta.label}
          </Pill>
        ) : (
          <Pill tone="neutral" className="shrink-0">
            {item.status}
          </Pill>
        )}
      </Link>
    </li>
  );
}

export function RelationshipsPanel({
  blockedBy,
  blocks,
  relatesTo,
  duplicates,
  clones,
  readiness,
  workflow,
}: RelationshipsPanelProps) {
  const groups = [
    { key: 'blocked_by', label: 'Blocked by', items: blockedBy, blockerGroup: true },
    { key: 'blocks', label: 'Blocks', items: blocks, blockerGroup: false },
    { key: 'relates_to', label: 'Relates to', items: relatesTo, blockerGroup: false },
    { key: 'duplicates', label: 'Duplicates', items: duplicates, blockerGroup: false },
    { key: 'clones', label: 'Clones', items: clones, blockerGroup: false },
  ];
  const nonEmpty = groups.filter((g) => g.items.length > 0);
  const hasBlockers = blockedBy.length > 0;
  const openBlockerIds = new Set(readiness.openBlockers.map((b) => b.id));

  return (
    <ContentSectionCard
      title="Relationships"
      subtitle="dependencies & links"
      headerRight={
        <span className="text-(--el-text-faint) inline-flex items-center gap-1.5 font-sans text-xs">
          <Link2 className="h-3.5 w-3.5" aria-hidden />
          Manage in Epic 5
        </span>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Readiness reads off the dependency in-edges, so it shows only when
            there ARE blockers — an item nothing blocks has no signal to give. */}
        {hasBlockers ? (
          <ReadinessBadge
            ready={readiness.ready}
            blockers={readiness.openBlockers.map((b) => ({
              identifier: b.identifier,
              href: `/issues/${b.identifier}`,
            }))}
          />
        ) : null}

        {nonEmpty.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-secondary) italic">
            No linked issues yet.
          </p>
        ) : (
          nonEmpty.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-2">
                <SectionLabel label={group.label} />
                <span className="text-(--el-text-faint) font-mono text-[11px]">
                  {group.items.length}
                </span>
              </div>
              <ul className="flex flex-col">
                {group.items.map((item) => (
                  <LinkRow
                    key={item.id}
                    item={item}
                    workflow={workflow}
                    isOpenBlocker={group.blockerGroup && openBlockerIds.has(item.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </ContentSectionCard>
  );
}
