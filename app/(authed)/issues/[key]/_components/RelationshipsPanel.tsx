import Link from 'next/link';
import type { ReadinessVerdictDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkflowDto, StatusCategoryDto } from '@/lib/dto/workflows';
import { ContentSectionCard } from './ContentSectionCard';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';

// The relationships panel on the issue detail page (Story 2.4 · Subtask 2.4.5):
// the item's dependency + link surface, READ-ONLY (creating/removing links is a
// later surface — Epic 5 collaboration; the documented "manage dependencies"
// extension slot lives here). It groups the work_item_link edges (1.4.3) by
// kind — blocked-by / blocks / relates-to / duplicates / clones — each linked
// item shown as a navigable row (type icon · identifier · title · status pill),
// mirroring the 2.4.3 ChildList row grammar. No links at all → a muted empty
// state, never blank (the AC).
//
// Above the groups sits the ready/blocked badge (`ReadinessBadge`), fed the
// service `readiness` verdict (2.2.6's `isReady` payoff — finding #21; this is
// its first PRODUCTION caller). It renders only when the item HAS blockers — an
// item with no dependency in-edges has no readiness signal to show. When all
// blockers are terminal the badge reads "Ready"; otherwise "Blocked by <ids>",
// each blocker judged against ITS OWN project's terminal set inside the service.

const STATUS_TONE: Record<StatusCategoryDto, NonNullable<PillProps['status']>> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

interface LinkGroupSpec {
  key: string;
  label: string;
  items: WorkItemSummaryDto[];
}

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

// One linked item: a row navigating to its own detail page. A status the
// bundled workflow knows renders as a lifecycle Pill; a cross-project status it
// doesn't classify falls back to a neutral chip (the link target can live in
// another project — mirror of ChildList's fallback).
function LinkRow({ item, workflow }: { item: WorkItemSummaryDto; workflow: WorkflowDto }) {
  const statusMeta = workflow.statuses.find((s) => s.key === item.status);
  return (
    <li>
      <Link
        href={`/issues/${item.identifier}`}
        className="hover:bg-(--el-surface) group flex items-center gap-2 rounded-md px-2 py-1.5 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <IssueTypeIcon type={item.kind} className="h-4 w-4 shrink-0" />
        <span className="text-(--el-text-muted) shrink-0 font-mono text-xs">{item.identifier}</span>
        <span className="text-(--el-text) min-w-0 flex-1 truncate font-sans text-sm group-hover:underline">
          {item.title}
        </span>
        {statusMeta ? (
          <Pill status={STATUS_TONE[statusMeta.category]}>{statusMeta.label}</Pill>
        ) : (
          <Pill tone="neutral">{item.status}</Pill>
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
  const groups: LinkGroupSpec[] = [
    { key: 'blocked_by', label: 'Blocked by', items: blockedBy },
    { key: 'blocks', label: 'Blocks', items: blocks },
    { key: 'relates_to', label: 'Relates to', items: relatesTo },
    { key: 'duplicates', label: 'Duplicates', items: duplicates },
    { key: 'clones', label: 'Clones', items: clones },
  ];
  const nonEmpty = groups.filter((g) => g.items.length > 0);
  const hasBlockers = blockedBy.length > 0;

  return (
    <ContentSectionCard title="Relationships">
      <div className="flex flex-col gap-4">
        {/* Readiness reads off the dependency in-edges, so it shows only when
            there ARE blockers — an item nothing blocks has no signal to give. */}
        {hasBlockers ? (
          <ReadinessBadge
            ready={readiness.ready}
            blockers={readiness.openBlockers.map((b) => b.identifier)}
          />
        ) : null}

        {nonEmpty.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-secondary) italic">No linked issues.</p>
        ) : (
          nonEmpty.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <SectionLabel label={group.label} />
              <ul className="-mx-2 flex flex-col">
                {group.items.map((item) => (
                  <LinkRow key={item.id} item={item} workflow={workflow} />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </ContentSectionCard>
  );
}
