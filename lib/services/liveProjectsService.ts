import {
  type LiveProjectQuery,
  type LiveProjectVerdict,
  type LiveProjectsResponse,
} from '@/lib/codeGraph/liveProjects';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE LIVE-PROJECT READ (MOTIR-2197 ·
// `docs/decisions/code-graph-index-fleet.md` §14.5) — the only question
// motir-ai's offboarding backstop (MOTIR-2169) needs motir-core to answer:
// *of the tenants I am storing a code graph for, which still exist?*
//
// **It answers about the pairs it is GIVEN, and never enumerates.** "Return every
// live project" is the easier endpoint and the wrong one to own: an unbounded
// cross-tenant inventory crossing a service boundary, growing with the business,
// that the caller does not need — the backstop starts from what it has STORED, so
// the set is already bounded by its own bucket. Inverting the direction keeps the
// blast radius of a leak proportional to what the caller already knew.
//
// SYSTEM CONTEXT: the read spans workspaces by definition, and has no acting user.
// The route's service-bearer gate is the authorization; this is the RLS reach.

export const liveProjectsService = {
  /**
   * Resolve each pair to `live` / `absent` / `unknown`.
   *
   * ⚠️ **A pair is only `absent` when the database ANSWERED and did not contain
   * it.** If the read itself fails, this throws rather than returning a page of
   * `absent` verdicts — the caller would delete every graph in the batch on the
   * strength of a failed query. That is the single most dangerous thing this
   * endpoint could do, and it is prevented by not catching.
   *
   * The verdicts come back in the order asked, one per pair, so a caller can zip
   * them against its own list without matching on identity.
   */
  async resolve(pairs: LiveProjectQuery[]): Promise<LiveProjectsResponse> {
    if (pairs.length === 0) return { projects: [] };

    const live = await withSystemContext((tx) =>
      projectRepository.findLivePairs(
        pairs.map((pair) => ({
          workspaceId: pair.coreWorkspaceId,
          projectId: pair.coreProjectId,
        })),
        tx,
      ),
    );

    const liveKeys = new Set(live.map((row) => key(row.workspaceId, row.projectId)));
    const projects: LiveProjectVerdict[] = pairs.map((pair) => ({
      ...pair,
      // `absent` is CONFIRMED, not inferred from a missing row in a partial
      // result: the query above either answered for the whole batch or threw.
      status: liveKeys.has(key(pair.coreWorkspaceId, pair.coreProjectId)) ? 'live' : 'absent',
    }));

    return { projects };
  },
};

/** A collision-free composite key — the ids are cuids, so a separator suffices. */
function key(workspaceId: string, projectId: string): string {
  return `${workspaceId} ${projectId}`;
}
