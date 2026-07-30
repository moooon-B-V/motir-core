import { getPreplanState } from '@/lib/ai/motirAiClient';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { ProjectRepoNameTakenError } from '@/lib/projectRepos/errors';
import { deriveRepoSetProposal, type ProposedRepoRow } from '@/lib/projectRepos/proposal';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ProjectRepoDto, ProjectRepoRoleDto } from '@/lib/dto/projectRepos';

// PROPOSING the project's repository set (Story MOTIR-1775 · MOTIR-1881) — the
// card that answers "how many repositories does this project need?", fired at plan
// approval so the establish step has an editable set to show instead of inventing
// a repo count at render time.
//
// Two halves, deliberately split:
//
//   * `lib/projectRepos/proposal.ts` DERIVES — pure, no DB, no network, no plan.
//   * this service GATHERS the signals (a project read + the motir-ai pre-plan
//     read over the 7.1 boundary) and PERSISTS the result through
//     `projectRepoSetService.addRow`, which is the only writer of that table.
//
// SCOPE (the card's boundary). Derivation + persistence of `proposed` rows only.
// It creates nothing on GitHub (MOTIR-1781), renders and edits nothing
// (MOTIR-1782 owns the user's edits), defines no table (MOTIR-1780 shipped it),
// decides no ownership/target account (ADR §3 — the establish step's), and adds no
// architecture field to the plan or to discovery (ADR §0.3 settled that no such
// record should exist: the confirmed repo set IS the architecture decision's home).
//
// 4-layer (CLAUDE.md): a service that orchestrates ANOTHER service plus one
// repository read, with no Prisma of its own. Every write goes through
// `projectRepoSetService`, so the access gate, the RLS-bound workspace context,
// the name validation and the `(project, name)` uniqueness guard are enforced
// exactly once, in the substrate that owns them.

/** Options for {@link projectRepoProposalService.proposeRepositorySet}. */
export interface ProposeRepositorySetOptions {
  /**
   * ADR §0.1.1's PRIMARY signal — the repo roles the generated tree pins.
   *
   * The caller supplies them because the plan is what carries them, and today
   * NOTHING does: a proposal has no repo field on `origin/main`. MOTIR-1885 makes
   * motir-ai's generator emit the role and MOTIR-1884 carries it through
   * `PlanItemProposedFields` → materialize; ADR §5.5 names both as the producers
   * this seam waits on. Until then `approvePlan` passes none and the ladder
   * degrades to the platform / default-web rungs — which is the honest answer, not
   * a gap to paper over by inferring roles from card prose.
   */
  itemRoles?: readonly ProjectRepoRoleDto[];
}

/**
 * What a proposal run did. `proposed: false` is a normal, expected outcome — the
 * run is idempotent by refusing to touch a set that already exists — so callers
 * branch on it rather than treating it as a failure.
 */
export type ProposeRepositorySetResult =
  | {
      proposed: true;
      /** The derived rows, each carrying the §0.1 signal that justified it. */
      rows: ProposedRepoRow[];
      /** The `proposed` rows as persisted, in set order (primary first). */
      created: ProjectRepoDto[];
    }
  | {
      proposed: false;
      /**
       * `set_exists` — the project already has a set, which this run must not
       * touch. `raced` — a concurrent run won the name; the DB's unique index
       * arbitrated and this run stopped rather than duplicating. `no_project` —
       * the project vanished between the gate and the read, so there is nothing
       * to name a repository after.
       */
      reason: 'set_exists' | 'raced' | 'no_project';
    };

export const projectRepoProposalService = {
  /**
   * Derive the project's repository set and write it as editable `proposed` rows.
   *
   * ══ IDEMPOTENCE ══ The guard is one rule, and it is deliberately the blunt one:
   * **a project whose set has ANY row is left completely alone.** That is what
   * makes every guarantee the card asks for hold at once — running twice produces
   * one set; a row the user removed is not resurrected; a row in `created` /
   * `connected` / `skipped` / `failed` is never modified or deleted (a `created`
   * repo is shipped reality, and a proposer that overwrote it would destroy the
   * association). A finer per-row rule cannot do this: "re-add a row that is
   * missing" and "leave a removed row removed" are the same observation, so any
   * proposer that adds into a non-empty set necessarily resurrects.
   *
   * The one corner that rule cannot distinguish: a user who removes EVERY row
   * leaves the set indistinguishable from one that was never proposed, so the next
   * approve proposes again. Telling them apart needs a "the proposer has run"
   * marker on the project — a column on MOTIR-1780's table, which this card's
   * scope boundary keeps it out of. A user who wants no repository skips the row
   * (ADR §4.3 — a skipped row leaves the project explicitly code-less, and a
   * `skipped` row is still a row, so the set is not empty and this never fires).
   *
   * ══ FAILURE ══ Every read this needs can be absent, and none of them may fail
   * the run: a project that never ran a pre-plan (migrated, seeded) reads
   * `session: null`, and the motir-ai boundary can be down. Both degrade through
   * ADR §0.1's ladder to the one-web-repo default, per the ADR's own consequence
   * for this card. What is NOT swallowed is a write failure — the caller
   * (`approvePlan`) is the one that makes the whole thing best-effort, and an error
   * that reaches it is real.
   */
  async proposeRepositorySet(
    projectId: string,
    ctx: ServiceContext,
    options: ProposeRepositorySetOptions = {},
  ): Promise<ProposeRepositorySetResult> {
    // The idempotence guard, and also the cheap gate that keeps the pre-plan
    // round-trip off every re-plan approve of an already-established project.
    // Access-gated (browse) by the set service, so an actor who may not see the
    // project gets its 404/403 here rather than after a derivation.
    const existing = await projectRepoSetService.listByProject(projectId, ctx);
    if (existing.length > 0) return { proposed: false, reason: 'set_exists' };

    const project = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      (tx) => projectRepository.findById(projectId, tx),
    );
    // The gate above already proved the project is browsable; a null here means it
    // was deleted underneath us, and there is nothing to name a repository after —
    // reported as its own reason rather than folded into `set_exists`, which would
    // put a false statement in the caller's log.
    if (!project) return { proposed: false, reason: 'no_project' };

    const preplan = await readPreplanSignals(ctx.workspaceId, projectId);

    const rows = deriveRepoSetProposal({
      projectSlug: project.slug,
      itemRoles: options.itemRoles,
      platform: preplan.platform,
      designStarter: preplan.designStarter,
    });

    // Rows are written one at a time, each in its own transaction. That is the
    // shape ADR §4.2 already fixes for this table — rows are INDEPENDENT and
    // nothing is rolled back — and the `(project_id, name)` unique index, not this
    // loop, is the real arbiter of a concurrent run. A lost race is therefore not
    // an error to report but a signal that someone else proposed first: stop, and
    // leave whatever they wrote alone (the same "never touch an existing set" rule
    // as above, arriving a few milliseconds later).
    const created: ProjectRepoDto[] = [];
    for (const row of rows) {
      try {
        created.push(
          await projectRepoSetService.addRow(
            projectId,
            {
              role: row.role,
              name: row.name,
              seedSource: row.seedSource,
              // WHY this row is here, PERSISTED (MOTIR-1892) — not merely
              // returned. The proposer runs once, so a signal that lived only in
              // this result would be gone by the time the establish step renders
              // the set on any later page load.
              proposalSignal: row.signal,
            },
            ctx,
          ),
        );
      } catch (err) {
        if (err instanceof ProjectRepoNameTakenError) return { proposed: false, reason: 'raced' };
        throw err;
      }
    }

    // WHY each row is there travels BOTH ways now (MOTIR-1892): the machine-
    // readable `signal` is persisted on the row (`created[i].proposalSignal`), so
    // the establish-step UI can show what Motir inferred on any later page load —
    // which matters because this proposer runs exactly once. The English `reason`
    // stays on the RESULT only: it is a log / PR-output gloss, not a localized
    // string, so it has no business on a rendered surface.
    return { proposed: true, rows, created };
  },
};

/**
 * Read ADR §0.1's secondary signals — `platform` and `designStarter` — from the
 * pre-plan session over the 7.1 boundary (`GET /v1/preplan`, the same read
 * `conventionEstablishService` uses for its stack hint).
 *
 * BEST-EFFORT by contract: the session lives in motir-ai and returns
 * `session: null` for any project that never ran a pre-plan, so "absent" is a
 * normal answer and a transport failure must read the same way. Both leave the
 * ladder to fall to its next rung rather than fail the derivation.
 */
async function readPreplanSignals(
  workspaceId: string,
  projectId: string,
): Promise<{ platform: string | null; designStarter: string | null }> {
  try {
    const state = await getPreplanState({
      coreWorkspaceId: workspaceId,
      coreProjectId: projectId,
    });
    return {
      platform: state.session?.platform ?? null,
      designStarter: state.session?.designStarter ?? null,
    };
  } catch {
    return { platform: null, designStarter: null };
  }
}
