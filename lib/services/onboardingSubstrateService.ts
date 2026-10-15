import 'server-only';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import {
  ONBOARDING_SUBSTRATE_ITEM_CAP,
  type OnboardingSubstrate,
  type OnboardingSubstrateRepository,
} from '@/lib/dto/onboardingSubstrate';

// THE ONBOARDING SUBSTRATE READ (Story MOTIR-4753 · MOTIR-4756).
//
// One answer to *"what does this project already have?"*, for the two callers
// that need it and neither of which could get it before:
//
//  - THE ENTRANCE ROUTER (`app/(onboarding)/onboarding/page.tsx`), which asked
//    HALF the question. It read `countProjectIssues` and handed it to
//    `shouldRouteToMigrateWizard`, whose first line was `if (itemCount <= 0)
//    return false` — there was no repository input anywhere in that predicate.
//    So a project with a connected, indexed repository and zero work items fell
//    through to the start-fresh entrance, and start-fresh discovery is not
//    code-grounded (`MIGRATE_DISCOVERY_PROMPT` is passed only by the migrate
//    wizard). That user's codebase — the best evidence Motir will ever have
//    about what they are building — went unopened for the whole journey.
//  - THE STEP MACHINE, which is about to ask whether the substrate answers
//    `discovery`'s own questions (the sibling this card unblocks).
//
// ⚠️ IT REPORTS; IT JUDGES NOTHING. Whether this substrate is ENOUGH is the
// planner's judgement (motir-ai, MOTIR-4758), and whether a step may be skipped
// is the step machine's. This module answers a question of fact and stops there.
//
// Layered per `CLAUDE.md`: a service composing EXISTING repository reads and the
// migrate gate's own resolution. No Prisma outside a repository, and no new query.
//
// ⚠️ THE CONNECTION HALF IS ORGANISATION-TIER (MOTIR-8481), the same
// `githubInstallationService.resolveOrganizationConnectedRepos` the migrate
// wizard's CONNECT gate answers from (MOTIR-8480). It used to be the workspace's
// own grant, so a project whose ORGANISATION connected code from a sibling
// workspace was let through the gate and then grounded on "no code connected" by
// every surface that reads this. The INDEXED half stays workspace-keyed: it is the
// resolution's `indexed`, joined from the same `job_run` ledger read the wizard's
// INDEX step waits on and the gate's kick fills for this workspace.

// ⚠️ THE SHAPE MOVED TO `lib/dto/` (MOTIR-4768) and is re-exported here, so no
// caller moved. It had to: the plan window RENDERS this substrate, and
// `PlanningReadingState` / `PlanningWorkspaceOverlay` are `'use client'` islands
// that `tests/planning/planChangeArchitecture.test.ts` refuses — correctly — to
// let import a service module at all. A service is `server-only`; its DTO is not.
export {
  ONBOARDING_SUBSTRATE_ITEM_CAP,
  type OnboardingSubstrate,
  type OnboardingSubstrateRepository,
};

/**
 * Read the substrate for one project.
 *
 * The two halves are independent reads and run together. The item read takes
 * `cap + 1` rows and reports the overflow as truncation — the cheapest way to
 * learn *"and more"* from a repository operation that already exists, and the
 * reason no new query is added for it.
 */
export async function readOnboardingSubstrate(
  projectId: string,
  ctx: { userId: string; workspaceId: string },
  /**
   * The cap to read at. Defaults to {@link ONBOARDING_SUBSTRATE_ITEM_CAP}; a
   * caller with its own bound passes one, and a test drives the truncation
   * BOUNDARY at a small cap rather than seeding two hundred rows to reach the
   * default.
   */
  options: { itemCap?: number } = {},
): Promise<OnboardingSubstrate> {
  const itemCap = options.itemCap ?? ONBOARDING_SUBSTRATE_ITEM_CAP;
  const [items, code] = await Promise.all([
    withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByProject(projectId, { take: itemCap + 1 }, tx),
    ),
    resolveConnectedRepos(ctx),
  ]);

  const itemCountTruncated = items.length > itemCap;

  // ⚠️ ORDER IS THE RESOLUTION'S, and it is left alone deliberately: the reading
  // state renders one row per repository, and a surface whose rows reshuffle
  // between two renders of the same project reads as something changing when
  // nothing has. Its empty set is `undefined` — normalised, exactly as before.
  const repositories = (code?.repos ?? []).map((repo) => ({
    ref: repo.repoRef,
    indexed: repo.indexed,
  }));

  return {
    itemCount: itemCountTruncated ? itemCap : items.length,
    itemCountTruncated,
    repositories,
    // BOTH derived from the list above, so a caller reading the booleans and a
    // caller reading the names can never be told different things.
    repositoryConnected: repositories.length > 0,
    repositoryIndexed: repositories.some((repo) => repo.indexed),
  };
}

/** The connection half — the organisation derived from the WORKSPACE row, never
 *  from a request, then the migrate gate's own resolution. */
async function resolveConnectedRepos(ctx: { userId: string; workspaceId: string }) {
  const organizationId = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => resolveOrganizationId(ctx.workspaceId, tx),
  );
  return githubInstallationService.resolveOrganizationConnectedRepos({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    organizationId,
  });
}

export const onboardingSubstrateService = { readOnboardingSubstrate };
