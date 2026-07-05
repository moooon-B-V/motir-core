import type { IssueDetailDto, WorkItemRefMap } from '@/lib/dto/workItems';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { LinkedPullRequestDto } from '@/lib/dto/github';
import type { Locale } from '@/lib/i18n/locales';
import { formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';

// Shapes the heavy IssueDetailDto (the SAME aggregate read the full detail page
// uses) into the condensed, serializable QuickViewData the peek modal renders
// (Subtask 2.5.19; moved out of the former IssueQuickViewContent server
// component for bug 8.8.2, where the peek became a client-fetched island).
// Member ids are resolved to display names here (server-side) so the client
// panel stays purely presentational. The readiness verdict is passed through
// unchanged — an item with NO blockers is `ready` (bug-ready-banner-no-deps);
// open blockers are named so the panel can map each to a `?peek=` swap-peek link.
//
// 8.8.8 widened the payload to the full core-field set (type/executor/labels/
// components/sprint/story-points/custom-fields/audit). All of it rides the
// SAME detail aggregate read EXCEPT the sprint NAME — `sprintId` is on the
// detail item but the name is not, so the service resolves it and hands it in
// as `sprintName` (the one field this mapper cannot derive from `detail`).
//
// 5.8.6 threads in `workItemRefs` (resolved `motir:` references in the
// description, for the peek body's live chips) + `projectIdentifier` (the prefix
// the peek header's title-linkify matches bare keys against) — both resolved by
// the service, since neither rides the detail aggregate.
export function toQuickViewData(
  detail: IssueDetailDto,
  members: WorkspaceMemberDTO[],
  locale: Locale,
  sprintName: string | null,
  workItemRefs: WorkItemRefMap,
  projectIdentifier: string,
  pullRequests: LinkedPullRequestDto[],
): QuickViewData {
  const { item, parent, workflow } = detail;
  const nameById = new Map(members.map((m) => [m.userId, m.name || m.email]));
  const status = workflow.statuses.find((s) => s.key === item.status);

  return {
    identifier: item.identifier,
    title: item.title,
    projectIdentifier,
    workItemRefs,
    kind: item.kind,
    statusLabel: status?.label ?? item.status,
    statusCategory: status?.category ?? null,
    descriptionMd: item.descriptionMd,
    type: item.type,
    executor: item.executor,
    assigneeName: item.assigneeId ? (nameById.get(item.assigneeId) ?? null) : null,
    reporterName: nameById.get(item.reporterId) ?? item.reporterId,
    priority: item.priority,
    labels: detail.labels.map((l) => ({ id: l.id, name: l.name })),
    components: detail.components.map((c) => ({ id: c.id, name: c.name })),
    dueLabel: item.dueDate ? formatDate(item.dueDate, locale) : null,
    sprintName,
    storyPoints: item.storyPoints,
    estimateLabel:
      item.estimateMinutes != null ? formatDurationMinutes(item.estimateMinutes) : null,
    customFields: detail.customFields,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    parent: parent
      ? { identifier: parent.identifier, title: parent.title, kind: parent.kind }
      : null,
    readiness: {
      ready: detail.readiness.ready,
      blockers: detail.readiness.openBlockers.map((b) => b.identifier),
      blockedByAncestor: detail.readiness.blockedByAncestor
        ? {
            identifier: detail.readiness.blockedByAncestor.identifier,
            title: detail.readiness.blockedByAncestor.title,
          }
        : null,
    },
    pullRequests,
  };
}
