import { withSystemContext } from '@/lib/workspaces/context';
import { getGitProvider, providerSupportsRepoTarballUrl } from '@/lib/git';
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

// codeGraphIndexService (Story 7.5 · MOTIR-1500, the motir-core producer half) —
// the business logic behind the code-graph jobs' READ half. When a repo is
// connected (or pushed to), this resolves WHICH tenant and WHICH projects a
// graph must be built for; the building itself happens in a fleet container
// (`docs/decisions/code-graph-index-fleet.md` §2), so no repo bytes and no host
// token ever pass through this file — the open-core invariant, docs/ai-boundary.md.
//
// 4-layer (CLAUDE.md): the job handler is the "service caller" for a background
// trigger, so the work lives here, not in the definition file, exactly as
// `billingSeatSync` delegates to `billingService`. This service owns the
// repository reads (through the leaves), the RLS context, and the enqueue
// gating. `resolveIndexTarget` is the checkpointed read the step shape drives;
// what the definition file adds is only the SHAPE (which call is a `step.run`),
// which is Inngest's concern and belongs with the job, not in here.
//
// TENANCY (the RESOLVED current-stage fan-out): a repo belongs to a WORKSPACE
// (`GithubRepo.workspaceId` since MOTIR-1931 — NOT the installation's, which is
// NULL for Motir's shared provisioning installation), but motir-ai's code-graph
// tenant is PROJECT-scoped (the planner resolves `aiProjectId` from a planning
// job's `projectId`). So this slice takes the repo's workspace off the job
// payload, resolves its `organizationId` → ALL its projects, and the fan-out
// dispatches ONE container PER PROJECT for the same repo. A repo connected or
// created for a workspace is therefore indexed into each of that workspace's
// projects' stores.
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
// transaction (RLS-safe under the trusted-writer escape, like the webhook); every
// network side effect — the container dispatch, the enqueues — happens AFTER that
// transaction closes, so a transaction is never held open across a GitHub,
// motir-ai or orchestrator round-trip.

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

/**
 * Why a run indexed nothing. Three of the four are "the tenant went away or has
 * nowhere to put a graph"; `provider_cannot_index` is different in KIND and is
 * called out here so a reader never mistakes it for one of those (MOTIR-2124).
 *
 * ⚠️ `provider_cannot_index` MEANS "THIS REPO WILL NEVER BE INDEXED", NOT
 * "NOT THIS TIME". The other three are transient by nature — re-connect the
 * installation, re-create the workspace, add a project, and the next run indexes.
 * This one is a property of the HOST (it cannot hand a token-less container a
 * self-authorizing archive URL — see `providerSupportsRepoTarballUrl`), so no
 * retry, re-push or re-connect will ever change it. It is recorded as a clean
 * terminal verdict rather than thrown for exactly that reason: a throw would buy
 * five identical retries and a dead-letter row per push, which is the defect this
 * value exists to remove — but a verdict is only honest if it is not silent, so
 * the refusal ALSO logs, and the connect surface tells the user up front.
 */
export type IndexSkipReason =
  | 'installation_missing'
  | 'workspace_missing'
  | 'no_projects'
  | 'provider_cannot_index';

/** A small JSON-serializable summary persisted on the job_run ledger row. */
export type IndexRepoResult =
  | { indexed: false; reason: IndexSkipReason }
  | { indexed: true; repoRef: string; projectsIndexed: number };

/**
 * What the job needs to know before it can index anything: the skip reason, or
 * the resolved tenant tuple + the full project fan-out. JSON-SERIALIZABLE by
 * construction — it is a `step.run` result, so it crosses a checkpoint boundary
 * and is replayed from Inngest's memo on every later invocation (MOTIR-1974).
 */
export type IndexTarget =
  | { indexed: false; reason: IndexSkipReason }
  | {
      indexed: true;
      repoRef: string;
      providerId: GitProviderId;
      organizationId: string;
      /** EVERY project of the repo's workspace — the fan-out is workspace-scoped
       *  (see the TENANCY note above); one index step lands per entry. */
      projectIds: string[];
    };

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

    // ⚠️ THE CAPABILITY GATE, AND IT BELONGS HERE — NOT AT THE ENQUEUE (MOTIR-2124).
    //
    // The fleet hands a container a PRE-SIGNED URL and no host credential, so a
    // provider that cannot resolve one cannot be indexed at all. Until this gate
    // existed, that fact was discovered at `bootIndexContainer`, which THROWS
    // (`requireRepoTarballUrlResolver`) — correct in isolation, catastrophic as a
    // steady state: an unindexable host burned all five Inngest attempts and
    // dead-lettered on every first index and every push, and the only record was a
    // `job_run_dlq` row nobody reads. 35 of them accumulated over 48 h once
    // (MOTIR-2105) before anyone noticed.
    //
    // Refusing HERE — one checkpointed, DB-only step, before the fleet-config gate
    // and before a single container is billed — turns that into ONE clean terminal
    // verdict per trigger, carrying the reason, on the ledger row the run already
    // writes.
    //
    // WHY NOT "at the enqueue", which is where the bug report asked for it: the
    // enqueue helpers are provider-blind by construction (`CodeGraphIndexData`
    // carries `installationId`, not a provider), so gating there means a GitLab
    // check in `gitlabConnectionService` and another in `gitlabWebhookService` —
    // two per-provider copies of a rule, in the two files a third provider would
    // have to remember to edit. That is the same class of miss that produced this
    // bug: MOTIR-1981 swept the JOBS and not the PROVIDER INTERFACE they depend on
    // (`notes.html` #215). This is the ONE place every path to a container passes
    // through, and it reads the capability itself rather than a provider name, so
    // a future provider is covered the day it registers — without editing this
    // line.
    //
    // It sits AFTER the three tenant verdicts deliberately: "the workspace is
    // gone" is a truer description of that run than "the host cannot index", and
    // the vanished-tenant contract predates this.
    //
    // `getGitProvider` THROWS on an id no provider registered, so it is resolved
    // inside the same guard rather than beside it: this step's shipped contract is
    // that it never throws (the vanished-tenant verdicts have to reach the ledger),
    // and an unregistered provider is in any case the strongest possible instance
    // of "this cannot be indexed" — it collapses into the same verdict rather than
    // into a crash.
    let canIndex: boolean;
    try {
      canIndex = providerSupportsRepoTarballUrl(getGitProvider(resolved.providerId));
    } catch {
      canIndex = false;
    }
    if (!canIndex) {
      // The verdict alone would be honest but quiet — a ledger value is legible to
      // whoever already went looking. Log it too, so the fact reaches an operator
      // reading logs, and the user-facing half is the connect surface's own copy
      // (`gitlab.projects.foot`). Arguments, never interpolated: `repoOwner` is
      // webhook-derived on the push path (`js/tainted-format-string`, CodeQL high).
      console.warn(
        '[codeGraphIndexService] skipping the code-graph index: this Git provider cannot ' +
          'resolve a pre-signed tarball URL, so a fleet container could never fetch the repo. ' +
          'No retry will change this. provider / repo:',
        resolved.providerId,
        repoRefOf({ owner: input.repoOwner, name: input.repoName }),
      );
      return { indexed: false, reason: 'provider_cannot_index' };
    }

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

  // ⚠️ PHASE 2 IS NOT HERE ANY MORE, AND MUST NOT COME BACK (MOTIR-2057). This
  // service used to own `indexRepoIntoProject` — fetch the repo's tarball into
  // this process, POST the bytes to motir-ai under a 180 s client deadline — and
  // MOTIR-2027 left it in place for
  // `system.code-graph-refresh` after moving first-index to the container fleet.
  // Production then ran the abandoned path for weeks at a ~68% failure rate:
  // `motir-core`'s whole-tree parse does not fit in 180 s, and its retries
  // starved every other repo's refresh. Both jobs now build on the fleet
  // (`lib/jobs/indexFleetSteps.ts` → `codeGraphIndexDispatchService`), so this
  // file is READS ONLY — the tenant/fan-out resolve above, and the two enqueue
  // paths below. Anything that wants a graph built dispatches a container.

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
