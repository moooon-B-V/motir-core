import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import { toMonitorIssueLinkDto } from '@/lib/mappers/monitorIssueLinkMappers';
import { monitorIssueRepository } from '@/lib/repositories/monitorIssueRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// The monitor-issue READ side (Story MOTIR-4932 · Subtask MOTIR-5730) — what a
// work item's Errors section renders from.
//
// ⚠️ IT NEVER CALLS THE PROVIDER. Every fact on a link was stored by the
// reconciler (MOTIR-5578, MOTIR-5729) or the sync (MOTIR-5701); opening a card
// reads that store and trusts it. A page that asked the monitor on load would be
// slow, and would break exactly when the connection is broken — which is when a
// person most needs to see what the card already knows.
//
// ⚠️ AND IT IS GATED LIKE THE CARD, NOT LIKE THE MONITOR. The section is for the
// teammate who never set the monitor up, so the gate is "can you read this work
// item", not `integration:manage` or `work_item:edit`.

export const monitorIssueService = {
  /**
   * Every monitor issue linked to one work item, most recently seen first, each
   * with its stored facts, its connection's labels, and its resolve-back and
   * assignee notes. `[]` for a card with no link.
   *
   * The item is resolved under the caller's workspace binding and must belong to
   * it — another workspace's item is {@link WorkItemNotFoundError}, the same
   * no-existence-leak answer the item page gives — and then the caller must be
   * able to BROWSE its project (`assertCanBrowse`, the item page's own gate).
   * The links are read under the same binding, so `monitor_issue`'s policy
   * scopes them too.
   */
  async listForWorkItem(workItemId: string, ctx: ServiceContext): Promise<MonitorIssueLinkDto[]> {
    const item = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findById(workItemId, tx),
    );
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(workItemId);
    }
    await projectAccessService.assertCanBrowse(item.projectId, ctx);

    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      monitorIssueRepository.listByWorkItemWithConnection(workItemId, tx),
    );
    return rows.map(toMonitorIssueLinkDto);
  },
};
