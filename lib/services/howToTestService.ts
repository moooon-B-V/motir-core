import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { testInstructionsRepository } from '@/lib/repositories/testInstructionsRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { toTestInstructionsDto } from '@/lib/mappers/testInstructionsMappers';
import { staleSections } from '@/lib/howToTest/assemble';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { HowToTestDto } from '@/lib/dto/howToTest';
import { authorOf, dispatchRunLabel } from '@/lib/howToTest/author';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { resolveRunTarget } from './runTarget';

// `dispatchRunLabel` moved to `@/lib/howToTest/author` when the v1 read needed it
// too (MOTIR-5454). Re-exported here so its existing importers are unchanged.
export { dispatchRunLabel } from '@/lib/howToTest/author';

/**
 * The HOW TO TEST read (Story MOTIR-4906 · Subtask MOTIR-5333) — per RUN TARGET
 * (`docs/decisions/approval-gates.md` §9's 2026-09-13 amendment): the item's
 * current record, and which of its repository sections were written for a commit
 * the bound pull request has since moved past (`design/github/design-notes.md`
 * § 25). A child of a container run that carries no record of its own answers
 * `tested_via_ancestor`, naming the nearest ancestor that does.
 *
 * ⚠️ IT NO LONGER DERIVES PER-REPOSITORY FACTS (MOTIR-5691). The preview, the
 * fetch line and the checks went with the sub-block that drew them, and so did
 * the two deployment reads that fed the preview. The deliveries and the project's
 * repositories stay, because STALE needs each section's bound pull request and
 * the repository's name.
 *
 * Called from the server-rendered item page (MOTIR-5336). It adds no HTTP route,
 * writes nothing, calls no host API, and only IMPORTS `prCiState`'s head rule.
 *
 * ⚠️ BOUNDED QUERIES, independent of how many repositories or pull requests: the
 * ancestors (1), the subtree (1), the item's record history (1), the ancestors'
 * current records (1), the latest leg run and scope run (2), the PUBLISHERS of
 * the current record and every history row TOGETHER (1 — MOTIR-5454), the
 * project's repositories (1), and the deliveries of the item and its descendants
 * with their check rows (1). The subtree, the repositories and the deliveries are
 * read only for a record that HAS sections.
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
        // A short page, not one row: the newest leg can be a `fix` repair, which
        // owes no record, and the run behind it is the one that does.
        dispatchRunRepository.listByWorkItem(item.id, { take: 10 }, tx),
        dispatchRunRepository.listByScope(item.id, { take: 1 }, tx),
      ]);

      const current = history.find((row) => row.isCurrent) ?? null;
      const earlier = history.filter((row) => !row.isCurrent);

      // ONE query for every publisher on this item — the current record and all
      // its history together. `history` already holds both, so the id set is
      // known before any of them is mapped; resolving per row would make the
      // query count grow with the number of versions.
      const publisherIds = [
        ...new Set(
          history.flatMap((row) => (row.publishedById !== null ? [row.publishedById] : [])),
        ),
      ];
      const publishers =
        publisherIds.length > 0 ? await userRepository.findByIds(publisherIds) : [];
      const nameById = new Map(publishers.map((user) => [user.id, user.name] as const));

      const historyDto = earlier.map((row) => ({
        recordId: row.id,
        author: authorOf(row, nameById),
        createdAt: row.createdAt.toISOString(),
      }));

      // THE RUN TARGET — the one resolution the approve-to-merge gate's raise also
      // calls (MOTIR-5515), so the block a person reads and the gate a person is
      // asked cannot name two different cards. Since MOTIR-5611 that is the card's
      // single `pull_request_approval` gate.
      const target = await resolveRunTarget({ hasCurrentRecord: current !== null, ancestors }, tx);

      if (!current) {
        if (target.kind === 'ancestor') {
          return {
            state: 'tested_via_ancestor',
            runTarget: { key: target.holder.identifier },
            owedBy: null,
            record: null,
            stale: [],
            history: historyDto,
          };
        }
        // ⚠️ A REPAIR RUN OWES NOTHING (MOTIR-5460). `motir fix` pushes onto pull
        // requests an EARLIER run opened and wrote How to test for; naming it as the
        // run that owes a record would blame the repair for the delivering run's gap.
        const latest = [legRuns.find((run) => run.command !== 'fix'), scopeRuns[0]]
          .filter((run): run is NonNullable<typeof run> => run !== undefined)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
        return {
          state: 'record_missing',
          runTarget: null,
          owedBy: latest
            ? { runId: latest.id, label: dispatchRunLabel(latest.command, latest.startedAt) }
            : null,
          record: null,
          stale: [],
          history: historyDto,
        };
      }

      const record = toTestInstructionsDto(current);
      const recordDto = {
        id: record.id,
        author: authorOf(current, nameById),
        createdAt: record.createdAt,
        bodyMd: record.bodyMd,
        previewPath: record.previewPath,
      };
      // A record with NO sections — every person's save (§ 25), and an agent's that
      // named no repository — can never be stale: there is no commit for a head to
      // have moved past. So the three reads below, which exist only to answer
      // that, are not made.
      if (record.repos.length === 0) {
        return {
          state: 'record',
          runTarget: null,
          owedBy: null,
          record: recordDto,
          stale: [],
          history: historyDto,
        };
      }

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
        state: delivery.pullRequest.state,
        checkRuns: delivery.pullRequest.checkRuns,
      });
      const own = deliveries.filter((d) => d.workItemId === item.id).map(toPr);
      const descendants = deliveries.filter((d) => d.workItemId !== item.id).map(toPr);

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
        record: recordDto,
        stale: staleSections(record.repos, own, descendants, (id) => nameOf.get(id) ?? id),
        history: historyDto,
      };
    });
  },
};
