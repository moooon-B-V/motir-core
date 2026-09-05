import type { GithubRepo } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { getCodeGraphStatus, type RawCodeGraphRepoStatus } from '@/lib/ai/motirAiClient';
import { MotirAiError } from '@/lib/ai/errors';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import type { CodeContextDTO, CodeContextRepoDTO, CodeRepoVerdict } from '@/lib/dto/codeContext';

// The CODE-CONTEXT service (Story MOTIR-1754 · MOTIR-1767) — the CONSUMER half of
// this story's boundary seam, and the single read both of its UI surfaces are fed
// from. It answers one question: **what code can the planner see, and how current
// is it?**
//
// It joins three sources that each already exist:
//
//   1. the workspace's connected repo set — `resolveCodeContext`, the very
//      function that builds `context.code` for a planning job, so "would the
//      planner get code context?" is answered by the SAME predicate rather than
//      by a second one that can drift from it;
//   2. each repo's index freshness — motir-ai's `GET /v1/code-graph/status`
//      (MOTIR-1765), one call for the whole set;
//   3. each repo's default-branch head — `GithubRepo.lastPushSha` (MOTIR-1766).
//
// Shape follows `aiConventionService` exactly: gate, then reach the store ONLY
// over the 7.1 boundary through the `motirAiClient` leaf, then map to DTOs.

/**
 * The per-repo verdict — a TOTAL function over four states.
 *
 * ⚠️ A NULL `headSha` means UNKNOWN, and unknown resolves to `current`, NEVER to
 * `stale`. A repository connected before the head column shipped, or one whose
 * provider does not record a head, must not be accused of being behind on missing
 * evidence. This is the one place a wrong default would put a false warning in
 * front of every existing user, which is why it is an explicit branch with a test
 * of its own rather than a fall-through.
 */
export function resolveVerdict(input: {
  indexed: boolean;
  indexedCommitSha: string | null;
  headSha: string | null;
  indexingInFlight: boolean;
}): CodeRepoVerdict {
  if (!input.indexed) return input.indexingInFlight ? 'indexing' : 'never_indexed';
  if (input.headSha === null) return 'current';
  if (input.indexedCommitSha === null) return 'current';
  return input.indexedCommitSha === input.headSha ? 'current' : 'stale';
}

/** The no-code-context answer, returned WITHOUT calling motir-ai at all. */
function noCodeContext(hasImplementedWork: boolean): CodeContextDTO {
  return { hasCodeContext: false, repos: [], hasImplementedWork, freshnessUnavailable: false };
}

export const codeContextService = {
  /**
   * The active project's code context.
   *
   * ⚠️ Gated on BROWSE, not on `ai:configure`. `aiConventionService` gates its
   * reads on `ai:configure` because a convention is AI CONFIGURATION; this is not
   * — it is the honest state of the planner's inputs, rendered on `/planning`
   * beside the thing that is about to use it. Anyone who can open that surface
   * needs it, and a browse gate is what the card's own acceptance criterion names.
   */
  async getCodeContext(projectId: string, ctx: AccessActorContext): Promise<CodeContextDTO> {
    await projectAccessService.assertCanBrowse(projectId, ctx);

    const { hasImplementedWork, repos, indexingInFlight } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (
        tx,
      ): Promise<{
        hasImplementedWork: boolean;
        repos: GithubRepo[];
        indexingInFlight: boolean;
      }> => {
        // "Has anybody reported implementing work here?" — EXISTS-shaped, not a
        // row scan. Deliberately NOT "any done item" (a project migrated from
        // another tracker is full of those, implemented by nobody through Motir)
        // and NOT "any pull-request link" (that presumes the very connection the
        // affordance is asking for).
        const implemented = await tx.workItem.findFirst({
          where: { projectId, implementationSource: { not: null } },
          select: { id: true },
        });

        const installation = await githubInstallationRepository.findByWorkspaceId(
          ctx.workspaceId,
          tx,
        );
        const rows = installation
          ? await githubRepoRepository.listByInstallation(installation.id, tx)
          : [];

        // The ledger cannot say WHICH repo a running index belongs to — an
        // in-flight `system.code-graph-index` row writes `output.repoRef` only on
        // SUCCESS — so this signal is workspace-AGGREGATE, exactly as the migrate
        // wizard's own index step reads it. It therefore only ever promotes a
        // never-indexed repo to `indexing`; it never claims a stale repo is
        // moving, which is the claim `design/code-context/design-notes.md` §6.1
        // forbids without proof.
        const running = rows.length
          ? await jobRunRepository.findRunningCodeGraphIndexForWorkspace(ctx.workspaceId, tx)
          : null;

        return {
          hasImplementedWork: implemented !== null,
          repos: rows,
          indexingInFlight: running !== null,
        };
      },
    );

    // ⚠️ A workspace with no installation SHORT-CIRCUITS — no boundary round-trip
    // at all. `resolveCodeContext` is the same predicate the job envelope is built
    // from, so "the planner would get no code context" and "there is nothing to
    // ask motir-ai about" are one fact, not two.
    const code = await resolveCodeContext({ userId: ctx.userId, workspaceId: ctx.workspaceId });
    if (!code) return noCodeContext(hasImplementedWork);

    const repoRefs = repos.map((repo) => `${repo.owner}/${repo.name}`);

    // ONE boundary call for the WHOLE set, never one per repo.
    let freshness: Map<string, RawCodeGraphRepoStatus> | null = null;
    try {
      const raw = await getCodeGraphStatus({
        coreWorkspaceId: ctx.workspaceId,
        coreProjectId: projectId,
        repoRefs,
      });
      freshness = new Map(raw.repos.map((r) => [r.repoRef, r]));
    } catch (err) {
      // ⚠️ AN AI-SIDE FAILURE MUST NEVER 500 THE PLANNING WORKSPACE. The surface
      // still renders: the connection facts are motir-core's own and are still
      // true, and freshness degrades to an explicit unknown rather than to a
      // guess. Anything that is NOT a boundary failure still throws.
      if (!(err instanceof MotirAiError)) throw err;
      freshness = null;
    }

    const dtos: CodeContextRepoDTO[] = repos.map((repo) => {
      const repoRef = `${repo.owner}/${repo.name}`;
      const status = freshness?.get(repoRef) ?? null;
      const indexed = status?.indexed ?? false;
      const indexedCommitSha = status?.commitSha ?? null;
      return {
        repoRef,
        provider: repo.provider,
        verdict: resolveVerdict({
          indexed,
          indexedCommitSha,
          headSha: repo.lastPushSha,
          // With no freshness answer we know nothing about what is in flight
          // either, so the honest verdict is `never_indexed`, not `indexing`.
          indexingInFlight: freshness === null ? false : indexingInFlight,
        }),
        indexedCommitSha,
        indexedAt: status?.indexedAt ?? null,
        codegraphVersion: status?.codegraphVersion ?? null,
        headSha: repo.lastPushSha,
        // ALWAYS NULL until its producer ships — a first-class, drawn answer, not
        // a gap. See the DTO's own note.
        commitsBehind: null,
      };
    });

    return {
      hasCodeContext: true,
      repos: dtos,
      hasImplementedWork,
      freshnessUnavailable: freshness === null,
    };
  },
};
