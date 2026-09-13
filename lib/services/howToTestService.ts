import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { testInstructionsRepository } from '@/lib/repositories/testInstructionsRepository';
import { repoDeploymentRepository } from '@/lib/repositories/repoDeploymentRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { toTestInstructionsDto } from '@/lib/mappers/testInstructionsMappers';
import { assembleHowToTest, liveHeadSha } from '@/lib/howToTest/assemble';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { HowToTestDto, HowToTestOwedByDto } from '@/lib/dto/howToTest';
import type { TestInstructionsDTO } from '@/lib/dto/testInstructions';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/**
 * The HOW TO TEST read (Story MOTIR-4906 · Subtask MOTIR-5333) — one block per
 * linked pull request, each path filled or saying why it is not.
 *
 * Called from the server-rendered item page (MOTIR-5336). It adds no HTTP route,
 * writes nothing, calls no host API, and only IMPORTS `prCiState`'s head rule.
 *
 * ⚠️ BOUNDED QUERIES, independent of how many pull requests a card has: the
 * deliveries with their check rows (1), the current records (1), the deployments
 * by head commit and by head ref (≤ 2, each batched), and the owing run (1).
 */
export const howToTestService = {
  async getForWorkItem(workItemId: string, ctx: ServiceContext): Promise<HowToTestDto> {
    const binding = { userId: ctx.userId, workspaceId: ctx.workspaceId };

    const item = await withWorkspaceContext(binding, (tx) =>
      workItemRepository.findById(workItemId, tx),
    );
    if (!item) throw new WorkItemNotFoundError(workItemId);
    // The same gate, and the same refusal, as the item page's other reads: a
    // reader who cannot browse the project gets the 404-shaped not-found.
    await projectAccessService.assertPermission(item.projectId, ctx, 'project:browse');

    return withWorkspaceContext(binding, async (tx) => {
      const [deliveries, records, runs] = await Promise.all([
        workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
        testInstructionsRepository.listCurrentByWorkItem(item.id, tx),
        dispatchRunRepository.listByWorkItem(item.id, { take: 1 }, tx),
      ]);

      const recordByRepo = new Map<string, TestInstructionsDTO>();
      for (const row of records) recordByRepo.set(row.repoId, toTestInstructionsDto(row));

      // One deployment read per KIND of key, however many pull requests.
      const byCommit: Array<{ repoId: string; commitSha: string }> = [];
      const byRef: Array<{ repoId: string; ref: string }> = [];
      for (const delivery of deliveries) {
        const pr = delivery.pullRequest;
        const headSha = liveHeadSha(pr.checkRuns);
        if (headSha) byCommit.push({ repoId: pr.repoId, commitSha: headSha });
        else byRef.push({ repoId: pr.repoId, ref: pr.headRef });
      }
      const [commitDeployments, refDeployments] = await Promise.all([
        repoDeploymentRepository.listLatestByCommits(byCommit, tx),
        repoDeploymentRepository.listLatestByRefs(byRef, tx),
      ]);
      const deployments = [...commitDeployments, ...refDeployments];

      const byPullRequestId: HowToTestDto['byPullRequestId'] = {};
      for (const delivery of deliveries) {
        const pr = delivery.pullRequest;
        byPullRequestId[pr.id] = assembleHowToTest(
          {
            id: pr.id,
            repoId: pr.repoId,
            headRef: pr.headRef,
            state: pr.state,
            merged: pr.merged,
            checkRuns: pr.checkRuns,
          },
          recordByRepo.get(pr.repoId) ?? null,
          deployments,
        );
      }

      const run = runs[0];
      const owedBy: HowToTestOwedByDto | null = run
        ? { runId: run.id, label: dispatchRunLabel(run.command, run.startedAt) }
        : null;

      return { byPullRequestId, owedBy };
    });
  },
};

/**
 * How a run is named in "Owed by {run}" — the command a person would have typed
 * and when it started, e.g. `motir run · 2026-09-13 12:04 UTC`. A scoped run is
 * `motir run` too; that is what its operator typed.
 */
export function dispatchRunLabel(command: string, startedAt: Date): string {
  const typed = command === 'run_scope' ? 'run' : command;
  const when = startedAt.toISOString().slice(0, 16).replace('T', ' ');
  return `motir ${typed} · ${when} UTC`;
}
