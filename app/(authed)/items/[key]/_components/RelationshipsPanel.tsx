import { useTranslations } from 'next-intl';
import type { ReadinessVerdictDto, RelationshipLinkDto } from '@/lib/dto/workItems';
import type { WorkflowDto, StatusCategoryDto } from '@/lib/dto/workflows';
import { ContentSectionCard } from './ContentSectionCard';
import { AddLinkControl } from './AddLinkControl';
import { RemoveLinkButton } from './RemoveLinkButton';
import { RelationshipPeekLink } from './RelationshipPeekLink';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';

// The relationships panel on the issue detail page (Story 2.4 · Subtasks 2.4.5
// + 2.4.9), per `design/work-items/relationships.mock.html` + `links.mock.html`:
// a LEFT-column section card grouping the work_item_link edges by kind
// (blocked-by / blocks / relates-to / duplicates / clones), with the
// ready/blocked banner at the top. READ surface from 2.4.5; 2.4.9 makes it
// EDITABLE on the detail page (`editable`): a "+ Link issue" add control + a
// per-row remove. The EDIT page reuses it the same editable way (user directive)
// so an editor manages dependency links without leaving the edit surface.

const STATUS_TONE: Record<StatusCategoryDto, NonNullable<PillProps['status']>> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

export interface RelationshipsPanelProps {
  blockedBy: RelationshipLinkDto[];
  blocks: RelationshipLinkDto[];
  relatesTo: RelationshipLinkDto[];
  duplicates: RelationshipLinkDto[];
  clones: RelationshipLinkDto[];
  readiness: ReadinessVerdictDto;
  /** The current item's status key — the readiness banner shows only while the
   *  item is in the `todo` category (resolved via `workflow`); "can I start
   *  this?" is moot once it's in-progress or done (2.5.21). */
  currentStatus: string;
  /** The item's project workflow — classifies a linked status into a Pill tone. */
  workflow: WorkflowDto;
  /** When set, render the add control + per-row remove (the detail page). The
   *  edit page omits these (read-only). Requires currentItemId + identifier. */
  editable?: boolean;
  currentItemId?: string;
  identifier?: string;
}

// One linked item: a navigable row (id+title share an inline baseline, icon/pill
// centered — the alignment the design specifies). When editable, a remove button
// sits OUTSIDE the link (an interactive control can't nest inside an anchor).
function LinkRow({
  link,
  workflow,
  isOpenBlocker,
  editable,
  identifier,
  relationshipLabel,
}: {
  link: RelationshipLinkDto;
  workflow: WorkflowDto;
  isOpenBlocker?: boolean;
  editable?: boolean;
  identifier?: string;
  relationshipLabel: string;
}) {
  const t = useTranslations('issueViews');
  const { item } = link;
  const statusMeta = workflow.statuses.find((s) => s.key === item.status);
  return (
    <li className="hover:bg-(--el-surface) flex items-center gap-1 rounded-md pr-1">
      <RelationshipPeekLink
        identifier={item.identifier}
        className="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {isOpenBlocker ? (
          <span
            className="bg-(--el-warning) h-1.5 w-1.5 shrink-0 rounded-full"
            aria-hidden
            title={t('openBlocker')}
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
      </RelationshipPeekLink>
      {editable && identifier ? (
        <RemoveLinkButton
          linkId={link.linkId}
          identifier={identifier}
          relationshipLabel={relationshipLabel}
          targetIdentifier={item.identifier}
        />
      ) : null}
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
  currentStatus,
  workflow,
  editable,
  currentItemId,
  identifier,
}: RelationshipsPanelProps) {
  const t = useTranslations('issueViews');
  const tl = useTranslations('labels');
  const groups = [
    {
      key: 'blocked_by',
      label: tl('relationship.blocked_by'),
      items: blockedBy,
      blockerGroup: true,
    },
    { key: 'blocks', label: tl('relationship.blocks'), items: blocks, blockerGroup: false },
    {
      key: 'relates_to',
      label: tl('relationship.relates_to'),
      items: relatesTo,
      blockerGroup: false,
    },
    {
      key: 'duplicates',
      label: tl('relationship.duplicates'),
      items: duplicates,
      blockerGroup: false,
    },
    { key: 'clones', label: tl('relationship.clones'), items: clones, blockerGroup: false },
  ];
  const nonEmpty = groups.filter((g) => g.items.length > 0);
  // The readiness banner shows for any TODO-category item: "can I start this?"
  // is moot once the item is in-progress or done (2.5.21, matching the
  // quick-view peek). An item with NO blockers is the most ready it can be, so
  // it shows the green "Ready to start" too — the badge renders off the
  // `readiness` verdict (ready when no blockers OR all terminal), not the
  // blocker count (bug-ready-banner-no-deps).
  const currentCategory = workflow.statuses.find((s) => s.key === currentStatus)?.category;
  const showReadiness = currentCategory === 'todo';
  const openBlockerIds = new Set(readiness.openBlockers.map((b) => b.id));
  const canEdit = Boolean(editable && currentItemId && identifier);

  return (
    <ContentSectionCard title={t('relationships')} subtitle={t('relationshipsGloss')}>
      <div className="flex flex-col gap-4">
        {canEdit ? (
          <AddLinkControl currentItemId={currentItemId!} identifier={identifier!} />
        ) : null}

        {/* Readiness shows while the item is still in the todo category
            (2.5.21): green "Ready to start" when ready (no blockers, or all
            terminal), peach "Blocked" naming the open blockers otherwise. */}
        {showReadiness ? (
          <ReadinessBadge
            ready={readiness.ready}
            blockers={readiness.openBlockers.map((b) => ({
              identifier: b.identifier,
              href: `/items/${b.identifier}`,
            }))}
            blockedByAncestor={
              readiness.blockedByAncestor
                ? {
                    identifier: readiness.blockedByAncestor.identifier,
                    title: readiness.blockedByAncestor.title,
                    href: `/items/${readiness.blockedByAncestor.identifier}`,
                  }
                : null
            }
          />
        ) : null}

        {nonEmpty.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-secondary) italic">
            {t('noLinkedIssues')}
          </p>
        ) : (
          nonEmpty.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-2">
                <SectionLabel label={group.label} />
                <span className="text-(--el-text-muted) font-mono text-[11px]">
                  {group.items.length}
                </span>
              </div>
              <ul className="flex flex-col">
                {group.items.map((link) => (
                  <LinkRow
                    key={link.linkId}
                    link={link}
                    workflow={workflow}
                    isOpenBlocker={group.blockerGroup && openBlockerIds.has(link.item.id)}
                    editable={canEdit}
                    identifier={identifier}
                    relationshipLabel={group.label}
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
