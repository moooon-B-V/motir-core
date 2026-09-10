import {
  type LiveOrganizationQuery,
  type LiveOrganizationVerdict,
  type LiveOrganizationsResponse,
} from '@/lib/codeGraph/liveOrganizations';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE LIVE-ORGANISATION READ (MOTIR-4647 · MOTIR-4642) — the question motir-ai's
// code-graph reconciler must ask once a graph is keyed to the ORGANISATION:
// *of the organisations I am storing a code graph for, which still exist?*
//
// The org-tier twin of `liveProjectsService`, and it exists rather than being a
// parameter on that one because the two answer about different tiers: the
// project read asks about a `(workspace, project)` pair and asserts the parent
// hop, this one asks about a root row and must NOT.
//
// **It answers about the ids it is GIVEN, and never enumerates.** "Return every
// live organisation" is the easier endpoint and the wrong one to own: an
// unbounded cross-tenant inventory crossing a service boundary, growing with the
// business, that the caller does not need — the reconciler starts from what it
// has STORED, so the set is already bounded by its own bucket.
//
// SYSTEM CONTEXT: the read spans organisations by definition and has no acting
// user. The route's service-bearer gate is the authorization; this is the RLS
// reach, and it is what makes `organization_system_read` admit the rows.

export const liveOrganizationsService = {
  /**
   * Resolve each organisation to `live` / `absent` / `unknown`.
   *
   * ⚠️ **An organisation is only `absent` when the database ANSWERED and did not
   * contain it.** If the read itself fails, this throws rather than returning a
   * page of `absent` verdicts — the caller would delete every graph in the batch
   * on the strength of a failed query. That is the single most dangerous thing
   * this endpoint could do, and it is prevented by not catching.
   *
   * The verdicts come back in the order asked, one per organisation, so a caller
   * can zip them against its own list without matching on identity.
   */
  async resolve(queries: LiveOrganizationQuery[]): Promise<LiveOrganizationsResponse> {
    if (queries.length === 0) return { organizations: [] };

    const live = await withSystemContext((tx) =>
      organizationRepository.findLiveIds(
        queries.map((query) => query.coreOrganizationId),
        tx,
      ),
    );

    const liveIds = new Set(live);
    const organizations: LiveOrganizationVerdict[] = queries.map((query) => ({
      ...query,
      // `absent` is CONFIRMED, not inferred from a missing row in a partial
      // result: the query above either answered for the whole batch or threw.
      status: liveIds.has(query.coreOrganizationId) ? 'live' : 'absent',
    }));

    return { organizations };
  },
};
