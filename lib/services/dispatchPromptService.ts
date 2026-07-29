import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { assembleDispatchPrompt } from '@/lib/dispatch/promptTemplate';
import type { DispatchPromptDto } from '@/lib/dto/dispatch';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { listConnectedRepoNames, resolveDispatchTargetRepo } from '@/lib/workItems/targetRepo';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The DISPATCH-PROMPT read (Story 7.9 · MOTIR-1802) — resolve everything the
// canonical prompt is assembled from, then hand it to the PURE assembler
// (`lib/dispatch/promptTemplate.ts`). This module is the only half that touches
// state; the grammar itself reads nothing, which is what keeps the prompt a pure
// function of server state (two calls for an unchanged item are byte-identical).
//
// It lives in its own service file rather than on `workItemsService` for the
// same reason `lib/workItems/targetRepo.ts` does: that service is already a
// 4000-line, coverage-gated module, and prompt assembly is a self-contained
// read with no write path, no transaction, and no shared state with it.
//
// Access: the item is resolved through `workItemsService.getWorkItemByIdentifier`,
// which enforces the workspace check AND the 6.4 browse gate and raises
// `WorkItemNotFoundError` either way — so an unknown key and another tenant's key
// are indistinguishable to the caller (no existence leak), exactly as every
// sibling read behaves.

/** The blockers of a work item, resolved to their `PROD-<n>` keys in ascending
 *  key order (deterministic — the prompt lists them verbatim). */
async function resolveBlockerKeys(workItemId: string): Promise<string[]> {
  const links = await workItemLinkRepository.findByFromItem(workItemId, 'is_blocked_by');
  const rows = await workItemRepository.findByIds(links.map((l) => l.toId));
  return rows
    .slice()
    .sort((a, b) => a.key - b.key)
    .map((r) => r.identifier);
}

export const dispatchPromptService = {
  /**
   * Assemble the canonical dispatch prompt for ONE work item.
   *
   * Reads, in parallel where they are independent: the item (access-gated), its
   * parent, its `is_blocked_by` dependencies, its READINESS (for the inherited
   * session branch — the one thing that picks the GIT WORKFLOW variant), and the
   * workspace's connected repo set (for `targetRepo`). `targetRepo` resolves
   * through the SAME `resolveDispatchTargetRepo` the ready dispatch payload uses
   * (MOTIR-1804), so the two dispatch surfaces can never route differently.
   *
   * Any work item can be asked for a prompt — not just a ready one. Readiness is
   * the CLI's concern (it dispatches from `claim_next_ready`); this is the
   * printable prompt for whatever key you name, which is what makes
   * `motir next --print <key>` and re-printing an in-progress item work.
   */
  async getDispatchPrompt(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<DispatchPromptDto> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);

    const [parentRow, blockerKeys, readiness, connectedRepos] = await Promise.all([
      item.parentId ? workItemRepository.findById(item.parentId) : Promise.resolve(null),
      resolveBlockerKeys(item.id),
      workItemsService.getReadiness(item.id, ctx),
      listConnectedRepoNames(ctx),
    ]);

    const targetRepo = resolveDispatchTargetRepo(item.targetRepo, connectedRepos);
    const assembled = assembleDispatchPrompt({
      key: item.identifier,
      title: item.title,
      kind: item.kind,
      type: item.type,
      executor: item.executor,
      priority: item.priority,
      storyPoints: item.storyPoints,
      estimateMinutes: item.estimateMinutes,
      descriptionMd: item.descriptionMd,
      blockerKeys,
      parent: parentRow ? { key: parentRow.identifier, title: parentRow.title } : null,
      projectName: project.name,
      projectKey: project.identifier,
      targetRepo,
      // The lineage this item inherits from its integrated dependencies
      // (`getReadiness` is the single source — it ignores a terminal blocker's
      // stale branch and collapses the one integrated lineage). An item that was
      // ITSELF already integrated falls back to its OWN recorded branch, so
      // re-printing its prompt keeps it on the lineage it already lives on
      // rather than sending it back to `origin/main`.
      sessionBranch: readiness.inheritedSessionBranch ?? item.sessionBranch,
    });

    return {
      key: item.identifier,
      prompt: assembled.prompt,
      targetRepo,
      workflowMode: assembled.workflowMode,
      sessionBranch: assembled.sessionBranch,
    };
  },
};
