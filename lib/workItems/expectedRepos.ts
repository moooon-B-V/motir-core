import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { toWorkItemRepositoryDtos } from '@/lib/mappers/workItemMappers';
import type { ExpectedRepo } from '@/lib/workItems/repoDelivery';
import type { Prisma } from '@/generated/prisma/client';

/**
 * What a work item's repository set EXPECTS, resolved through its references
 * (Story MOTIR-2732 · MOTIR-3043).
 *
 * ⚠️ WHY THIS EXISTS, and it is the story's central claim failing at the one
 * place that matters. `work_item.targetRepos` is a STORED projection of the
 * references, written when the item is written. Rename the repository on the
 * host and nothing rewrites it — the panel resolves through the references and
 * shows the new name, while the completion gate compares the OLD one against a
 * pull request that now reports the new one, matches nothing, and holds the card
 * open forever. A card that survives a rename everywhere except the gate has not
 * survived it.
 *
 * Found by the acceptance flow, which is the only place it could be found: every
 * unit test on either side was right about its own half.
 *
 * The stored names remain the FALLBACK and are not dead code — they are what a
 * project with no `project_repository` set still pins with (ADR §5's
 * compatibility rung).
 *
 * It also says, per repository, whether a CONTAINER's work there SHIPPED WITHOUT
 * A CHANGE REQUEST (MOTIR-7180): every live leaf targeting it is in a
 * done-category status and none carries a linked delivery. The completion gate,
 * its re-evaluation and the item panel all read the set through here, so all
 * three see the same answer — `classifyRepoDelivery` decides what it means.
 *
 * Requires `tx`: the join table is RLS-gated on a GUC bound only on a
 * transaction, and an unbound read returns `[]` — indistinguishable from "this
 * card has no repositories", which is the worse of the two failures.
 */
export async function resolveExpectedRepos(
  workItemId: string,
  targetRepos: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<ExpectedRepo[]> {
  if (targetRepos.length === 0) return [];
  const refs = await workItemRepoRepository.listByWorkItem(workItemId, tx);
  if (refs.length === 0) return targetRepos.map((repo) => ({ repo }));
  // MOTIR-7180 — what the item's LEAVES say about each repository. Only a
  // reference row can be matched to a leaf's reference, which is why the name
  // rung above carries no such evidence and keeps holding exactly as before.
  const settlement = new Map(
    (
      await workItemRepoRepository.listLeafSettlementForContainer(
        workItemId,
        refs[0]!.workspaceId,
        tx,
      )
    ).map((s) => [s.projectRepoId, s]),
  );
  return toWorkItemRepositoryDtos(refs).map((r) => {
    const s = settlement.get(r.ref);
    return {
      repo: r.name,
      establishState: r.state,
      role: r.role,
      shippedWithoutChangeRequest: s !== undefined && s.leaves > 0 && s.settled === s.leaves,
    };
  });
}
