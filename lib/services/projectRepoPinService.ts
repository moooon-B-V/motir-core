import type { Prisma, ProjectRepoRole } from '@prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  resolveRepoRoles,
  type RepoRoleOutcome,
  type ResolvedRepoRole,
} from '@/lib/projectRepos/roleResolution';

// RESOLVE the pinned ROLE to a real repository (Story MOTIR-1775 · MOTIR-1913) —
// the step that turns "this card belongs to the api layer" into an agent actually
// being told which checkout to build in.
//
// WHY THIS RUNS HERE AND NOT AT MATERIALIZE. ADR §5.3 places the resolution "at
// materialize", and against the shipped sequence it cannot happen there. Verified
// on `origin/main`: `plansService.approvePlan` materializes INSIDE the approve
// `$transaction` and only then fires `projectRepoProposalService.proposeRepositorySet`
// best-effort, after the transaction commits (the pre-plan read is a `server-only`
// client call that cannot run inside a tx) — so on the onboarding path the
// project's repo set does not exist yet when its items are created. And even once
// it does, its rows are `proposed`: `ESTABLISHED_PROJECT_REPO_STATES` is
// `['created', 'connected']`, which rows reach only through the creation primitive
// (MOTIR-1781) or the establish UI (MOTIR-1782), i.e. after the user confirms the
// set. Resolving at materialize would therefore write `null` for every role, every
// time. So the ROLE is recorded at materialize (MOTIR-1912) and RESOLVED here, when
// a row becomes established. §5.3's three outcomes are unchanged — only WHEN they
// are evaluated moves, because the ADR was written before the approve-time ordering
// shipped.
//
// THE POLICY IS NOT IN THIS FILE. `lib/projectRepos/roleResolution.ts` decides what
// a role means against a set (including why ambiguity is counted over rows in ANY
// state, which is what makes this pass order-independent). This service contributes
// the access gate, the lock, the transaction and the write.
//
// NO SIDE EFFECT IS HELD OPEN. Establishing a repository is a sequence of GitHub
// calls; this pass is the DB write that FOLLOWS one, in its own short transaction
// after the network work has resolved (ADR §4.2 + the side-effects-outside-tx
// rule). It is invoked from `projectRepoSetService.attachRealizedRepo` once that
// method's own locked transaction has committed — so every establish path reaches
// it, whether the row was created by MOTIR-1781 or connected to an existing repo by
// MOTIR-1782, and neither has to remember to call it.
//
// LOCK ORDER: `project_repository` (whole set) THEN `work_item`. Both locks order
// their rows by id, and every caller takes them in this order, so two concurrent
// passes queue rather than deadlock.

/** What one role's resolution did to the project's items. */
export interface RepoPinRoleResult {
  role: ProjectRepoRole;
  outcome: RepoRoleOutcome;
  /** The repo name pinned — non-null iff `outcome` is `resolved`. */
  repoName: string | null;
  /** Rows of the set carrying this role (the evidence behind an `ambiguous`). */
  rowIds: string[];
  /** Items this pass NEWLY pinned. 0 on a re-run, and 0 for every outcome but
   *  `resolved` — which is what makes "the pass is idempotent" and "it never
   *  guessed" observable rather than asserted. */
  pinned: number;
  /** Items still carrying this role with NO pin once the pass finished. Non-zero
   *  is the honest `unrouted` state the product renders, never a swallowed
   *  failure. */
  leftUnpinned: number;
}

export interface ResolveRepoPinsResult {
  projectId: string;
  /** One entry per role the project MENTIONS — on an unpinned item, in the set, or
   *  both — so a caller can render the whole picture from one result, including
   *  the roles that resolved to nothing and why. */
  roles: RepoPinRoleResult[];
  /** Total items newly pinned across every role. */
  pinned: number;
}

export const projectRepoPinService = {
  /**
   * Resolve EVERY role of a project and pin the items it can.
   *
   * Whole-project rather than per-row, even though the trigger is one row becoming
   * established: two of ADR §5.3's three outcomes are properties of the SET (how
   * many rows carry a role), so a correct answer has to look at all of it. Running
   * it once per established row is therefore not redundancy — a partially
   * established set (ADR §4: rows are independent, failure is honest) pins the
   * roles it can on each pass and leaves the rest legibly unrouted, and the pass
   * that follows the next row's establishment picks up exactly what became
   * resolvable.
   *
   * IDEMPOTENT AND NON-CLOBBERING. It only ever fills a `targetRepo` that is null,
   * so a re-run writes nothing (`pinned: 0`) and an item pinned explicitly — by a
   * human, or by a §5.4 settled-name proposal — is left exactly as it was. It also
   * never UN-pins: a row that later leaves the established states does not retract
   * a name that has already been dispatched against.
   *
   * Edit-gated, because it writes work items. A caller that has already proved
   * edit access still pays one access read; that is deliberate, so the method is
   * safe to call from anywhere rather than trusting its callers.
   */
  async resolvePins(projectId: string, ctx: ServiceContext): Promise<ResolveRepoPinsResult> {
    await projectAccessService.assertCanEdit(projectId, ctx);
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      (tx) => resolveInTransaction(projectId, ctx, tx),
    );
  },
};

async function resolveInTransaction(
  projectId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<ResolveRepoPinsResult> {
  // LOCK THE SET FIRST, then read it under the lock. The role → name answer is
  // derived from the set's shape, so the set must not move between deriving it and
  // writing the pins it implies (the lock-before-read-derived-update rule). An
  // empty set locks nothing and resolves nothing, which is the right answer for a
  // project that never ran the establish step.
  await projectRepoRepository.lockByProject(projectId, ctx.workspaceId, tx);
  const setRows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
  const resolvedRoles = resolveRepoRoles(setRows);

  const unpinnedCounts = await workItemRepository.countUnpinnedByRepoRole(
    projectId,
    ctx.workspaceId,
    tx,
  );
  const unpinnedByRole = new Map(unpinnedCounts.map((c) => [c.role, c.count]));

  // Every role the project mentions — from the SET and from the items — so a role
  // whose items exist but whose row was removed still reports `unestablished`
  // rather than silently vanishing from the result.
  const roles = new Set<ProjectRepoRole>([...resolvedRoles.keys(), ...unpinnedByRole.keys()]);

  const pinnedByRole = new Map<ProjectRepoRole, number>();
  const resolutions: ResolvedRepoRole[] = [];
  let pinnedTotal = 0;
  for (const role of roles) {
    const resolution: ResolvedRepoRole = resolvedRoles.get(role) ?? {
      role,
      outcome: 'unestablished',
      repoName: null,
      rowIds: [],
    };
    const unpinnedBefore = unpinnedByRole.get(role) ?? 0;
    resolutions.push(resolution);

    if (resolution.outcome !== 'resolved' || unpinnedBefore === 0) {
      if (resolution.outcome === 'ambiguous' && unpinnedBefore > 0) {
        // RECORDED, not swallowed. The result carries the verdict and the rows
        // that caused it; this line is what makes the refusal visible in the log
        // of a run nobody is watching, which is where an establish pass happens.
        console.warn(
          `[projectRepoPinService] project ${projectId}: role "${role}" is carried by ` +
            `${resolution.rowIds.length} rows of the repository set (${resolution.rowIds.join(', ')}), ` +
            `so ${unpinnedBefore} item(s) stay unpinned — an ambiguous role resolves to no repo ` +
            'rather than to an arbitrary one (ADR §5.3).',
        );
      }
      continue;
    }

    const ids = await workItemRepository.lockUnpinnedIdsByRepoRole(
      projectId,
      ctx.workspaceId,
      role,
      tx,
    );
    const pinned = await workItemRepository.pinTargetRepoByIds(ids, resolution.repoName!, tx);
    // ONE revision per item, in the SAME transaction as the write (the revisions
    // contract). `targetRepo` has a `textField()` disposition in
    // `lib/activity/renderers.ts`, so this renders in History with no new registry
    // entry — and it is the entry MOTIR-1912 deliberately deferred to here, having
    // left the ROLE out of its own diff so the feed reports the repo an item moved
    // to once that is a FACT, rather than announcing the intention twice.
    // Attributed to the actor who established the row, which is who caused it.
    for (const id of ids) {
      await workItemRevisionsService.recordRevision(
        {
          workItemId: id,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { targetRepo: { from: null, to: resolution.repoName } },
        },
        tx,
      );
    }

    pinnedTotal += pinned;
    pinnedByRole.set(role, pinned);
  }

  // RE-COUNT rather than subtract. `unpinnedBefore - pinned` would be a guess the
  // moment anything else wrote a pin while this pass ran — a concurrent hand-edit
  // is skipped by the write's own `targetRepo IS NULL` guard, so the item is
  // pinned but not by us, and arithmetic would report it as still unrouted. This
  // read is inside the same transaction as the writes, so what it returns is the
  // state this pass actually leaves behind.
  const remaining = new Map(
    (await workItemRepository.countUnpinnedByRepoRole(projectId, ctx.workspaceId, tx)).map((c) => [
      c.role,
      c.count,
    ]),
  );

  return {
    projectId,
    roles: resolutions.map((resolution) => ({
      ...resolution,
      pinned: pinnedByRole.get(resolution.role) ?? 0,
      leftUnpinned: remaining.get(resolution.role) ?? 0,
    })),
    pinned: pinnedTotal,
  };
}
