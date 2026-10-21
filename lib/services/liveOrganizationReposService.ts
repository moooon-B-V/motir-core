import type { LiveOrganizationQuery } from '@/lib/codeGraph/liveOrganizations';
import type {
  LiveOrganizationReposResponse,
  LiveOrganizationReposVerdict,
} from '@/lib/codeGraph/liveOrganizationRepos';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE CONNECTED-REPOSITORY READ (MOTIR-9137) — *of the organisations I store a
// code graph for, which still exist, and which repositories does each still
// have connected?* motir-ai's reconciler subtracts the answer from its own
// `CodeRepo` rows to find a graph whose repository left under another name.
//
// The repository-tier twin of `liveOrganizationsService`, with the same two
// properties that make that one safe to subtract from:
//
//   - **It answers about the ids it is GIVEN, and never enumerates.**
//   - **It answers for the whole batch or throws.** Both reads share ONE system
//     transaction, so an organisation is never reported `live` with a repository
//     list read from a different moment, and a failed read is a 500 rather than a
//     page of empty lists — which the caller would read as "every repository is
//     gone".
//
// SYSTEM CONTEXT: the read spans organisations by definition and has no acting
// user. The route's service-bearer gate is the authorization.

export const liveOrganizationReposService = {
  async resolve(queries: LiveOrganizationQuery[]): Promise<LiveOrganizationReposResponse> {
    if (queries.length === 0) return { organizations: [] };
    const ids = queries.map((query) => query.coreOrganizationId);

    const { liveIds, refs } = await withSystemContext(async (tx) => ({
      liveIds: new Set(await organizationRepository.findLiveIds(ids, tx)),
      refs: await githubRepoRepository.listRefsByOrganizations(ids, tx),
    }));

    const byOrganization = new Map<string, string[]>();
    for (const row of refs) {
      const list = byOrganization.get(row.organizationId) ?? [];
      list.push(`${row.owner}/${row.name}`);
      byOrganization.set(row.organizationId, list);
    }

    const organizations: LiveOrganizationReposVerdict[] = queries.map((query) => {
      const live = liveIds.has(query.coreOrganizationId);
      return {
        ...query,
        status: live ? 'live' : 'absent',
        repoRefs: live ? (byOrganization.get(query.coreOrganizationId) ?? []) : [],
      };
    });

    return { organizations };
  },
};
