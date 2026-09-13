import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { testInstructionsRepository } from '@/lib/repositories/testInstructionsRepository';
import { repoDeploymentRepository } from '@/lib/repositories/repoDeploymentRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { toTestInstructionsDto } from '@/lib/mappers/testInstructionsMappers';
import { assembleHowToTestRepo, liveHeadSha, pickPullRequest } from '@/lib/howToTest/assemble';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { HowToTestDto, HowToTestRunDto } from '@/lib/dto/howToTest';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/**
 * The HOW TO TEST read (Story MOTIR-4906 · Subtask MOTIR-5333) — per RUN TARGET
 * (`docs/decisions/approval-gates.md` §9's 2026-09-13 amendment): the item's
 * current run record, and per repository section its pull request, preview and
 * checks, each path filled or saying why it is not. A child of a container run
 * that carries no record of its own answers `tested_via_ancestor`, naming the
 * nearest ancestor that does.
 *
 * Called from the server-rendered item page (MOTIR-5336). It adds no HTTP route,
 * writes nothing, calls no host API, and only IMPORTS `prCiState`'s head rule.
 *
 * ⚠️ BOUNDED QUERIES, independent of how many repositories or pull requests: the
 * ancestors (1), the subtree (1), the item's record history (1), the ancestors'
 * current records (1), the latest leg run and scope run (2), the project's
 * repositories (1), the deliveries of the item and its descendants with their
 * check rows (1), and the deployments by head commit and by head ref (≤ 2).
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
      const [history, ancestors, legRuns, scopeRuns] = await Promise.all([
        testInstructionsRepository.listHistoryForWorkItem(item.id, tx),
        workItemRepository.findAncestors(item.id, ctx.workspaceId, tx),
        dispatchRunRepository.listByWorkItem(item.id, { take: 1 }, tx),
        dispatchRunRepository.listByScope(item.id, { take: 1 }, tx),
      ]);

      const current = history.find((row) => row.isCurrent) ?? null;
      const earlier = history.filter((row) => !row.isCurrent);
      const historyDto = earlier.map((row) => ({
        recordId: row.id,
        run: runOf(row.dispatchRunId, row.dispatchRun),
        createdAt: row.createdAt.toISOString(),
      }));

      if (!current) {
        // Nearest ancestor first — `findAncestors` returns root-first.
        const nearestFirst = [...ancestors].reverse();
        const ancestorRecords = await testInstructionsRepository.listCurrentByWorkItems(
          nearestFirst.map((a) => a.id),
          tx,
        );
        const holders = new Set(ancestorRecords.map((r) => r.workItemId));
        const holder = nearestFirst.find((a) => holders.has(a.id));
        if (holder) {
          return {
            state: 'tested_via_ancestor',
            runTarget: { key: holder.identifier },
            owedBy: null,
            record: null,
            repos: [],
            history: historyDto,
          };
        }
        const latest = [legRuns[0], scopeRuns[0]]
          .filter((run): run is NonNullable<typeof run> => run !== undefined)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
        return {
          state: 'record_missing',
          runTarget: null,
          owedBy: latest
            ? { runId: latest.id, label: dispatchRunLabel(latest.command, latest.startedAt) }
            : null,
          record: null,
          repos: [],
          history: historyDto,
        };
      }

      const record = toTestInstructionsDto(current);
      const [subtree, projectRepos] = await Promise.all([
        workItemRepository.findSubtree(item.id, tx),
        projectRepoRepository.listByProject(item.projectId, ctx.workspaceId, tx),
      ]);
      const descendantIds = subtree.filter((row) => row.id !== item.id).map((row) => row.id);
      const deliveries = await workItemDeliveryRepository.listByWorkItemsWithChecks(
        [item.id, ...descendantIds],
        tx,
      );
      const toPr = (delivery: (typeof deliveries)[number]) => ({
        id: delivery.pullRequest.id,
        repoId: delivery.pullRequest.repoId,
        headRef: delivery.pullRequest.headRef,
        state: delivery.pullRequest.state,
        merged: delivery.pullRequest.merged,
        checkRuns: delivery.pullRequest.checkRuns,
      });
      const own = deliveries.filter((d) => d.workItemId === item.id).map(toPr);
      const descendants = deliveries.filter((d) => d.workItemId !== item.id).map(toPr);

      const bound = record.repos.map((section) => ({
        section,
        pr: pickPullRequest(section.repoId, own, descendants),
      }));

      // One deployment read per KIND of key, however many sections.
      const byCommit: Array<{ repoId: string; commitSha: string }> = [];
      const byRef: Array<{ repoId: string; ref: string }> = [];
      for (const { pr } of bound) {
        if (!pr) continue;
        const headSha = liveHeadSha(pr.checkRuns);
        if (headSha) byCommit.push({ repoId: pr.repoId, commitSha: headSha });
        else byRef.push({ repoId: pr.repoId, ref: pr.headRef });
      }
      const [commitDeployments, refDeployments] = await Promise.all([
        repoDeploymentRepository.listLatestByCommits(byCommit, tx),
        repoDeploymentRepository.listLatestByRefs(byRef, tx),
      ]);
      const deployments = [...commitDeployments, ...refDeployments];

      const nameOf = new Map<string, string>();
      for (const row of projectRepos) {
        if (row.githubRepo)
          nameOf.set(row.githubRepo.id, `${row.githubRepo.owner}/${row.githubRepo.name}`);
      }
      for (const d of deliveries) nameOf.set(d.repo.id, `${d.repo.owner}/${d.repo.name}`);

      return {
        state: 'record',
        runTarget: null,
        owedBy: null,
        record: {
          id: record.id,
          run: runOf(current.dispatchRunId, current.dispatchRun),
          createdAt: record.createdAt,
          preconditionMd: record.preconditionMd,
          clickPathSteps: record.clickPathNotApplicable ? [] : record.clickPathSteps,
          clickPathNotApplicable: record.clickPathNotApplicable,
          clickPathNotApplicableReason: record.clickPathNotApplicableReason,
          previewPath: record.previewPath,
        },
        repos: bound.map(({ section, pr }) =>
          assembleHowToTestRepo(
            section,
            nameOf.get(section.repoId) ?? section.repoId,
            pr,
            deployments,
            record.previewPath,
          ),
        ),
        history: historyDto,
      };
    });
  },
};

function runOf(
  runId: string | null,
  run: { command: string; startedAt: Date } | null,
): HowToTestRunDto | null {
  if (!runId || !run) return null;
  return { runId, label: dispatchRunLabel(run.command, run.startedAt) };
}

/**
 * How a run is named in the block — the command a person would have typed and
 * when it started, e.g. `motir run · 2026-09-13 12:04 UTC`. A scoped run is
 * `motir run` too; that is what its operator typed.
 */
export function dispatchRunLabel(command: string, startedAt: Date): string {
  const typed = command === 'run_scope' ? 'run' : command;
  const when = startedAt.toISOString().slice(0, 16).replace('T', ' ');
  return `motir ${typed} · ${when} UTC`;
}
