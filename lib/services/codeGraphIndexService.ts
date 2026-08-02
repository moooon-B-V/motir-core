import { withSystemContext } from '@/lib/workspaces/context';
import { getGitProvider } from '@/lib/git';
import type { GitProviderId, NormalizedRepo } from '@/lib/git/types';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import {
  enqueueCodeGraphIndex,
  enqueueReposMissingFirstIndex,
  repoRefOf,
} from '@/lib/github/indexEnqueue';
import { indexCodeGraph } from '@/lib/ai/motirAiClient';

// codeGraphIndexService (Story 7.5 · MOTIR-1500, the motir-core producer half) —
// the business logic behind the `system.code-graph-index` background job. When a
// GitHub App installation adds a repo, motir-core fetches that repo's source at
// its default branch using the INSTALLATION token, then hands the raw
// gzipped-tarball BYTES to motir-ai to build a code graph. The credential + fetch
// stay in motir-core; motir-ai receives bytes, never a host token (the open-core
// invariant, docs/ai-boundary.md).
//
// 4-layer (CLAUDE.md): the job handler is the "service caller" for a background
// trigger, so ALL the work lives here, not in the definition file, exactly as
// `billingSeatSync` delegates to `billingService`. This service owns the
// repository reads (through the leaves), the RLS context, and the boundary
// calls. Since MOTIR-1974 it exposes the work as TWO methods rather than one —
// `resolveIndexTarget` (reads) and `indexRepoIntoProject` (one project's network
// side effects) — because each must be its own durable checkpoint. What the
// definition file adds is only the step SHAPE (which call is a `step.run`, and
// that phase 2 runs once per resolved project); that is Inngest's concern and
// belongs with the job, not in here.
//
// TENANCY (the RESOLVED current-stage fan-out): a repo belongs to a WORKSPACE
// (`GithubRepo.workspaceId` since MOTIR-1931 — NOT the installation's, which is
// NULL for Motir's shared provisioning installation), but motir-ai's code-graph
// tenant is PROJECT-scoped (the planner resolves `aiProjectId` from a planning
// job's `projectId`). So this slice takes the repo's workspace off the job
// payload, resolves its `organizationId` → ALL its projects, and calls motir-ai
// ONCE PER PROJECT with the SAME tarball bytes. A repo connected or created for a
// workspace is therefore indexed into each of that workspace's projects' stores.
//
// The precise repo↔project association this fan-out wanted NOW EXISTS
// (MOTIR-1780): `project_repository` is a project's repository SET, one row per
// intended repo, each carrying the realized `GithubRepo` it maps to — read it via
// `projectRepoSetService.getSet` / `listByProject`. This service is DELIBERATELY
// still workspace-scoped: narrowing the fan-out is a behaviour change to shipped,
// working code-graph plumbing, and it belongs to MOTIR-1754 (the BYOK code-index
// loop), which owns per-repo index freshness end to end. So the association is no
// longer missing — only unadopted here, and by whom is recorded. Do not read this
// paragraph as an invitation to fix it in passing.
//
// SIDE-EFFECTS-OUTSIDE-TX: the DB reads run inside one `withSystemContext`
// transaction (RLS-safe under the trusted-writer escape, like the webhook); the
// tarball fetch and the motir-ai upload are network side effects done AFTER that
// transaction closes — in a different method entirely since MOTIR-1974 — so a
// transaction is never held open across a GitHub / motir-ai round-trip.

export interface IndexRepoInput {
  /** GitHub's numeric installation id (as a string) — the token-minting key. */
  installationId: string;
  /** The workspace whose repo this is (MOTIR-1931) — stamped from the REPO row at
   *  enqueue time (`handlePush` resolves `repo.workspaceId`; the reconcile/bind
   *  path passes the workspace it just persisted the repo under), and already
   *  carried by both job payloads. NOT re-derived from the installation here: a
   *  Motir-created repo hangs off the shared provisioning installation, which
   *  names no workspace, so that hop would fan the index out into the wrong
   *  tenant's projects — or none. */
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  /** The ref to index — the repo's default branch. */
  defaultBranch: string;
}

/** A small JSON-serializable summary persisted on the job_run ledger row. */
export type IndexRepoResult =
  | { indexed: false; reason: 'installation_missing' | 'workspace_missing' | 'no_projects' }
  | { indexed: true; repoRef: string; projectsIndexed: number };

/**
 * What the job needs to know before it can index anything: the skip reason, or
 * the resolved tenant tuple + the full project fan-out. JSON-SERIALIZABLE by
 * construction — it is a `step.run` result, so it crosses a checkpoint boundary
 * and is replayed from Inngest's memo on every later invocation (MOTIR-1974).
 */
export type IndexTarget =
  | { indexed: false; reason: 'installation_missing' | 'workspace_missing' | 'no_projects' }
  | {
      indexed: true;
      repoRef: string;
      providerId: GitProviderId;
      organizationId: string;
      /** EVERY project of the repo's workspace — the fan-out is workspace-scoped
       *  (see the TENANCY note above); one index step lands per entry. */
      projectIds: string[];
    };

/** Everything one project's index step needs — the resolved tuple, flattened. */
export interface IndexProjectInput extends IndexRepoInput {
  providerId: GitProviderId;
  organizationId: string;
  repoRef: string;
  projectId: string;
}

/** A small JSON-serializable summary of ONE project's index step. */
export interface IndexProjectResult {
  projectId: string;
  repoRef: string;
  filesIndexed: number;
}

/** One repo the first-index sweep found without a code graph. */
export interface MissingFirstIndexRepo {
  workspaceId: string;
  /** GitHub's numeric installation id — the enqueue payload's token-minting key. */
  installationId: string;
  repoRef: string;
  defaultBranch: string;
}

/** What {@link codeGraphIndexService.sweepReposMissingFirstIndex} did. */
export interface FirstIndexSweepReport {
  dryRun: boolean;
  /** Connected repos examined. */
  scanned: number;
  /** Of those, the ones that already have a succeeded index — left alone. */
  alreadyIndexed: number;
  /** The repos with no code graph, in report order. */
  missing: MissingFirstIndexRepo[];
  /** How many index jobs were actually enqueued (0 on a dry run). */
  enqueued: number;
}

export const codeGraphIndexService = {
  /**
   * PHASE 1 (one checkpointed step) — resolve the tenant tuple and the project
   * fan-out for a repo. DB reads only: no network, so it is cheap to replay and
   * cheap to retry. No-ops cleanly (never throws) when the
   * installation/workspace vanished before the job ran or the workspace has no
   * projects — the no-op verdicts ARE the contract (the job never throws on a
   * vanished tenant), and they are returned rather than thrown so the ledger
   * records WHY nothing was indexed.
   *
   * Keyed by WORKSPACE: the input carries no project, and the fan-out this
   * returns is every project of the workspace (see the TENANCY note above).
   */
  async resolveIndexTarget(input: IndexRepoInput): Promise<IndexTarget> {
    const resolved = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        input.installationId,
        tx,
      );
      // The installation is still read — it supplies the provider discriminator
      // the tarball fetch dispatches on — but NOT the tenant (MOTIR-1931).
      if (!installation) return { kind: 'installation_missing' as const };

      const workspace = await workspaceRepository.findByIdInTx(input.workspaceId, tx);
      if (!workspace) return { kind: 'workspace_missing' as const };

      const projects = await projectRepository.findByWorkspace(input.workspaceId, tx);
      return {
        kind: 'resolved' as const,
        providerId: installation.provider as GitProviderId,
        workspaceId: input.workspaceId,
        organizationId: workspace.organizationId,
        projectIds: projects.map((p) => p.id),
      };
    });

    if (resolved.kind === 'installation_missing')
      return { indexed: false, reason: 'installation_missing' };
    if (resolved.kind === 'workspace_missing')
      return { indexed: false, reason: 'workspace_missing' };
    if (resolved.projectIds.length === 0) return { indexed: false, reason: 'no_projects' };

    return {
      indexed: true,
      // The SAME key the enqueue gate matches on (`repoRefOf`) — this is what
      // lands in the ledger as `output.repoRef`, so producer and gate share one
      // formatter.
      repoRef: repoRefOf({ owner: input.repoOwner, name: input.repoName }),
      providerId: resolved.providerId,
      organizationId: resolved.organizationId,
      projectIds: resolved.projectIds,
    };
  },

  /**
   * PHASE 2 (one checkpointed step PER PROJECT) — fetch the repo's tarball and
   * hand those bytes to motir-ai for ONE project. Network side effects only, and
   * no transaction is open across them.
   *
   * ⚠️ WHY ONE PROJECT PER CALL (MOTIR-1974). This used to be a single call that
   * fetched once and then uploaded N times in a loop — and because Inngest can
   * only checkpoint BETWEEN steps, the whole fetch + N uploads had to fit in ONE
   * platform invocation. It never did: all five production repos 504'd on
   * `FUNCTION_INVOCATION_TIMEOUT` and dead-lettered, the tiny starter repo
   * exactly like `motir-core`. Splitting the fan-out into a step per project
   * gives each upload its OWN invocation budget, and a failure resumes from the
   * project it died on instead of restarting the repo.
   *
   * ⚠️ WHY THE TARBALL IS RE-FETCHED PER PROJECT. A `step.run` result must be
   * JSON-serializable, so the bytes cannot cross a checkpoint — the fetch has to
   * live INSIDE whichever step uses them. Re-fetching is the price of the
   * checkpoint, and it is the cheap half: GitHub serves a pre-signed codeload
   * URL in seconds, while the upload waits on motir-ai building the graph. Note
   * that it costs nothing per invocation — replayed steps return from Inngest's
   * memo without executing, so each invocation still performs exactly ONE fetch
   * and ONE upload.
   *
   * ⚠️ WHY THE SAME BYTES ARE UPLOADED PER PROJECT AT ALL. motir-ai's code-graph
   * store is PROJECT-scoped (`aiProjectId`), so a workspace's N projects need N
   * stores; one upload cannot serve the workspace. Narrowing the fan-out to the
   * repo's actual projects via `project_repository` (MOTIR-1780) is real, is
   * unadopted here on purpose, and belongs to MOTIR-1754 — see the TENANCY note
   * above. Do not read this as an invitation to change it in passing.
   */
  async indexRepoIntoProject(input: IndexProjectInput): Promise<IndexProjectResult> {
    // The provider seam, dispatched by the discriminator phase 1 resolved.
    const provider = getGitProvider(input.providerId);
    const bytes = await provider.fetchRepoTarball(
      input.installationId,
      input.repoOwner,
      input.repoName,
      input.defaultBranch,
    );

    const result = await indexCodeGraph({
      coreOrganizationId: input.organizationId,
      coreWorkspaceId: input.workspaceId,
      coreProjectId: input.projectId,
      repoRef: input.repoRef,
      bytes,
    });

    return {
      projectId: input.projectId,
      repoRef: input.repoRef,
      filesIndexed: result.filesIndexed,
    };
  },

  /**
   * The repo-add paths' index trigger (MOTIR-1500, re-gated by MOTIR-1961) —
   * enqueue a first index for every repo of `repos` that has no code graph yet.
   * Called POST-COMMIT by BOTH producers (`bindInstallationForWorkspace` and the
   * webhook's `reconcileInstallation`), which is why the ledger read lives here
   * rather than being repeated in each: one gate, one place to keep correct.
   *
   * Reads the already-indexed set under system context — the grant/webhook paths
   * have no active workspace, and the `job_run` policy's system-admin branch is
   * what lets them read the ledger at all. Best-effort throughout: a ledger read
   * failure must not fail the grant that already committed, so it degrades to
   * "nothing is indexed" (enqueue everything — convergent, since the job is
   * idempotent) rather than propagating.
   */
  async enqueueFirstIndexForRepos(input: {
    installationId: string;
    workspaceId: string;
    repos: NormalizedRepo[];
  }): Promise<void> {
    if (input.repos.length === 0) return;
    let indexedRepoRefs: string[] = [];
    try {
      indexedRepoRefs = await withSystemContext((tx) =>
        jobRunRepository.listSucceededCodeGraphIndexRepoRefs(input.workspaceId, tx),
      );
    } catch (err) {
      // The workspace id is passed as an ARGUMENT, never interpolated into the
      // first argument: on the webhook path it is request-derived, and building
      // a format string out of it is `js/tainted-format-string` (CodeQL, high).
      console.error(
        'enqueueFirstIndexForRepos could not read the index ledger for workspace; ' +
          'treating every repo as un-indexed (the job is idempotent):',
        input.workspaceId,
        err,
      );
    }
    await enqueueReposMissingFirstIndex({
      installationId: input.installationId,
      workspaceId: input.workspaceId,
      repos: input.repos,
      indexedRepoRefs,
    });
  },

  /**
   * The OPERATOR recovery path (MOTIR-1961) — find every connected repo with no
   * code graph and enqueue its first index. Driven by
   * `pnpm db:backfill:code-graph-index`.
   *
   * The re-gated enqueue above repairs a workspace the next time its repo
   * selection changes; this repairs one that will not see that event soon (or at
   * all), which is exactly the state the defect leaves behind — repos persisted
   * before the feature shipped, never "newly added" again. Both roads lead to the
   * same chokepoint, so there is one enqueue payload, not two.
   *
   * Idempotent and safe to re-run: a repo whose index has since succeeded drops
   * out of the missing set, so a second consecutive run enqueues nothing. Scoped
   * to one workspace with `workspaceId`; unscoped it sweeps every tenant, which is
   * the honest default — the defect is not one workspace's.
   *
   * Runs under system context (it spans tenants and reads the untenanted job
   * ledger). Side effects are OUTSIDE the transaction: the reads close first,
   * then the enqueues fire.
   */
  async sweepReposMissingFirstIndex(
    input: { workspaceId?: string; dryRun?: boolean } = {},
  ): Promise<FirstIndexSweepReport> {
    const dryRun = input.dryRun ?? false;

    const { scanned, missing } = await withSystemContext(async (tx) => {
      const repos = await githubRepoRepository.listWithInstallation(tx, {
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      });
      // One ledger read per workspace, not per repo — the sweep is cross-tenant
      // and a workspace typically owns several repos.
      const indexedByWorkspace = new Map<string, Set<string>>();
      for (const workspaceId of new Set(repos.map((r) => r.workspaceId))) {
        const refs = await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(workspaceId, tx);
        indexedByWorkspace.set(workspaceId, new Set(refs));
      }
      const found: MissingFirstIndexRepo[] = [];
      for (const repo of repos) {
        const repoRef = repoRefOf(repo);
        if (indexedByWorkspace.get(repo.workspaceId)?.has(repoRef)) continue;
        found.push({
          workspaceId: repo.workspaceId,
          installationId: repo.installation.installationId,
          repoRef,
          defaultBranch: repo.defaultBranch,
        });
      }
      return { scanned: repos.length, missing: found };
    });

    let enqueued = 0;
    if (!dryRun) {
      for (const repo of missing) {
        const [repoOwner, repoName] = splitRepoRef(repo.repoRef);
        await enqueueCodeGraphIndex({
          installationId: repo.installationId,
          workspaceId: repo.workspaceId,
          repoOwner,
          repoName,
          defaultBranch: repo.defaultBranch,
        });
        enqueued += 1;
      }
    }

    return {
      dryRun,
      scanned,
      alreadyIndexed: scanned - missing.length,
      missing,
      enqueued,
    };
  },
};

/** Split an `owner/name` ref back into the enqueue payload's two fields. A repo
 *  name cannot contain `/`, so the FIRST separator is the only one. */
function splitRepoRef(repoRef: string): [owner: string, name: string] {
  const at = repoRef.indexOf('/');
  return [repoRef.slice(0, at), repoRef.slice(at + 1)];
}
