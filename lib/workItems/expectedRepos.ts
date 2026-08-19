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
  return toWorkItemRepositoryDtos(refs).map((r) => ({
    repo: r.name,
    establishState: r.state,
    role: r.role,
  }));
}
