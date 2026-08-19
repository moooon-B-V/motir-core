import { migrateOnboardingRepository } from '@/lib/repositories/migrateOnboardingRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// "Does this project have a codebase of its OWN?" — ONE implementation, for the
// two questions that turn out to be the same question (MOTIR-3073 · MOTIR-3086).
//
// MOTIR-3073 asked it to decide whether to PROPOSE a repository, and answered it
// inside `projectRepoProposalService` as a private helper. MOTIR-3086 needs the
// same answer to decide whether the project's repository SET is capable of being
// a complete statement of its repositories — `lib/workItems/dispatchRepo.ts`'s
// scope ladder. Two copies of a predicate whose whole content is "which field is
// the project-scoped one" is how the proposer and the resolver would come to
// disagree about which projects arrived with code, so the helper moved here and
// both import it.
//
// It reads a repository directly rather than sitting on a service, exactly as
// `lib/workItems/targetRepo.ts`'s `listConnectedRepoNames` does and for the same
// reason: it is one read answering one question, consumed by callers on both
// sides of the service layer, and routing it through a service would make
// `dispatchRepo` depend on the whole onboarding surface to ask a boolean.

/**
 * Does this project ALREADY have a codebase of its own — code it did NOT get from
 * its own repository set?
 *
 * Reads the project's onboarding run and asks whether it names a connected
 * repository. That field is the ONLY project-scoped record of a repository this
 * project did not get from the set: `GithubRepo` and the code-graph index ledger
 * are keyed on the WORKSPACE (`projectStateService.resolveCodeState` calls itself
 * "the workspace-scoped half"), so answering from either of those would say YES
 * for every project after the first in any workspace that has ever connected
 * code — and the second project in a workspace genuinely may have none of it.
 *
 * Keyed on the FIELD, not on `kind === 'migrate'`: any future onboarding path that
 * connects an existing repository records it in the same place and is covered the
 * day it ships. A run parked at `connect` with nothing connected answers NO, which
 * is correct — starting the wizard is not having code.
 *
 * ABSENT is NO, which is the answer for a project with no run at all (seeded, or
 * created straight in Motir).
 */
export async function projectHasItsOwnCode(
  projectId: string,
  ctx: ServiceContext,
): Promise<boolean> {
  const run = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    migrateOnboardingRepository.findByProjectId(projectId, ctx.workspaceId, tx),
  );
  return (run?.connectedRepoRef ?? null) !== null;
}
