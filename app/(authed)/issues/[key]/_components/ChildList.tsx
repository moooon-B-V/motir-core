import Link from 'next/link';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkflowDto, StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { ContentSectionCard } from './ContentSectionCard';
import { Pill, type PillProps } from '@/components/ui/Pill';

// The child list on the issue detail page (Story 2.4 · Subtask 2.4.3): the
// item's DIRECT children (one level — the `getIssueDetail` bundle's `children`,
// already position-ordered), each a link to its own detail page so the tree is
// navigable downward (the mirror of the parent breadcrumb). A row carries the
// child's type icon + identifier + title + status pill + assignee — the same
// fields a list row shows. A leaf (no children) renders NOTHING — no empty
// scaffold (the AC: "an item with no children shows nothing").
//
// Status tone reuses the lifecycle mapping (category → Pill variant); children
// share the item's project, so the bundled `workflow` classifies their status
// keys. Assignee resolves against the workspace members the page already loaded
// (the summary carries `assigneeId` only); unassigned children show no avatar.

const STATUS_TONE: Record<StatusCategoryDto, NonNullable<PillProps['status']>> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

// Initial-letter avatar — matches the detail rail's assignee chip
// (CoreFieldsPanel). Presentational; the row's accessible name carries identity.
function Avatar({ name }: { name: string }) {
  return (
    <span
      className="bg-foreground text-background inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export interface ChildListProps {
  items: WorkItemSummaryDto[];
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
}

export function ChildList({ items, workflow, members }: ChildListProps) {
  if (items.length === 0) return null;

  return (
    <ContentSectionCard
      title="Child issues"
      headerExtra={<Pill tone="neutral">{items.length}</Pill>}
    >
      <ul className="-my-1 flex flex-col">
        {items.map((child) => {
          const meta = ISSUE_TYPE_META[child.kind];
          const Icon = meta.icon;
          const statusMeta = workflow.statuses.find((s) => s.key === child.status);
          const assignee = child.assigneeId
            ? members.find((m) => m.userId === child.assigneeId)
            : undefined;
          return (
            <li key={child.id}>
              <Link
                href={`/issues/${child.identifier}`}
                className="hover:bg-surface group flex items-center gap-3 rounded-md px-2 py-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                <Icon className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
                <span className="text-muted-foreground shrink-0 font-mono text-xs">
                  {child.identifier}
                </span>
                <span className="text-foreground min-w-0 flex-1 truncate font-sans text-sm group-hover:underline">
                  {child.title}
                </span>
                {statusMeta ? (
                  <Pill status={STATUS_TONE[statusMeta.category]}>{statusMeta.label}</Pill>
                ) : (
                  <Pill tone="neutral">{child.status}</Pill>
                )}
                {assignee ? (
                  <span
                    className="flex shrink-0 items-center"
                    title={assignee.name || assignee.email}
                  >
                    <Avatar name={assignee.name || assignee.email} />
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </ContentSectionCard>
  );
}
