import { Prisma } from '@/generated/prisma/client';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { getGitProvider } from '@/lib/git';
import type { GitProviderId, NormalizedWorkflowRunEvent } from '@/lib/git/types';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import {
  ciWorkflowRunUsageRepository,
  type RepoPeriodTotal,
} from '@/lib/repositories/ciWorkflowRunUsageRepository';
import {
  ciPeriodUsageRepository,
  type OrgPeriodConsumption,
} from '@/lib/repositories/ciPeriodUsageRepository';
import {
  isCiMeteringEnabled,
  isMotirOwnedRepo,
  provisioningOrgLogin,
} from '@/lib/ciMetering/config';
import { normalizeRunUsage, type MeteredJob } from '@/lib/ciMetering/normalize';
import { periodEndFor, periodStartFor } from '@/lib/ciMetering/period';

// The CI-minutes METER (Story MOTIR-1775 · MOTIR-1896) — the MEASUREMENT half of
// the charging contract in `docs/decisions/ci-minutes-allowance.md`.
//
// Motir hosts every repository it creates for a new project in its own GitHub
// org, and private-repo Actions minutes bill to the REPOSITORY OWNER — so Motir
// pays for those users' CI from the first `motir run` onward, because every
// dispatch ends in a PR and every PR runs CI. This service measures that: it
// takes a COMPLETED `workflow_run` delivery, decides whether Motir paid for it,
// resolves whom it belongs to, converts it to Linux-equivalent minutes, and
// persists it idempotently, per calendar month.
//
// ⚠️ IT DEBITS NOTHING AND REFUSES NOTHING. No credit is spent, no balance is
// read, no dispatch is blocked here — that is MOTIR-1901's job, and the seam
// between the two is exactly ONE read: `getOrgPeriodConsumption`.
//
// The pipeline, and where each step is decided:
//
//   1. Enabled?          §8.5  — off-cloud, or no provisioning org: inert.
//   2. Does MOTIR pay?   §5.1  — the run's OWN repository owner == Motir's org.
//   3. Whom for?         §5.2  — repo → project-repo row → project → workspace → org.
//   4. Meta org?         §4.4  — the internal dogfood org is bypassed entirely.
//   5. Already metered?  §5.8  — a cheap pre-check; the unique index is the guard.
//   6. How much?         §3+§5.8 — Σ ceil(per-JOB minutes) × the runner's price ratio.
//   7. Record it.        §4.5  — one transaction: the audit row + the month's rollup.

const PROVIDER: GitProviderId = 'github';

export type MeterWorkflowRunOutcome =
  /** Off-cloud or no provisioning org configured — the meter is inert (§8.5). */
  | { outcome: 'disabled' }
  /** GitHub does not bill Motir for this repo: a connect-existing repo, or one
   *  already transferred to the user. Not an error — simply not metered (§5.1). */
  | { outcome: 'not_metered'; reason: 'foreign_owner' }
  /** The delivery names an installation or repo Motir has no mirror row for. */
  | { outcome: 'unknown_installation' }
  | { outcome: 'unknown_repo' }
  /** Motir IS billed, but the chain resolves no tenant — a repo in Motir's org
   *  whose project was deleted, or one belonging to no project. Real spend
   *  charged to nobody, and LOGGED, because silence here would hide it (§5.4). */
  | { outcome: 'unattributed'; repoOwner: string; repoName: string }
  /** The META org (moooon B.V.) — no pool accounting at all (§4.4). */
  | { outcome: 'bypassed_meta'; organizationId: string }
  /** This run attempt was already metered — counted once (§5.8). */
  | { outcome: 'duplicate'; runId: string; runAttempt: number }
  /** The run completed with no job that produced billable time. */
  | { outcome: 'no_billable_jobs'; runId: string }
  | {
      outcome: 'metered';
      runId: string;
      runAttempt: number;
      organizationId: string;
      workspaceId: string;
      projectId: string | null;
      periodStart: Date;
      billableMinutes: number;
      linearEquivalentMinutes: number;
    };

/** Whom a metered run belongs to — the §5.2 chain's output. */
interface Attribution {
  workspaceId: string;
  organizationId: string;
  projectId: string | null;
  githubRepoId: string;
  isMeta: boolean;
}

export const ciMinutesMeterService = {
  /**
   * Meter ONE completed workflow run. `installationId` is the host installation
   * id the delivery carried — used to resolve the repo mirror and to mint the
   * token the jobs read needs.
   *
   * Never throws for a run it simply does not meter: every "no" is a typed
   * outcome the webhook logs, because a webhook that 500s makes GitHub retry a
   * delivery there was never anything to do for.
   */
  async meterWorkflowRun(
    event: NormalizedWorkflowRunEvent,
    installationId: string,
  ): Promise<MeterWorkflowRunOutcome> {
    // 1 · §8.5 — self-host has no meter; an unprovisioned org has nothing that
    // could pass the gate.
    if (!isCiMeteringEnabled()) return { outcome: 'disabled' };

    // 2 · §5.1 — the gate, keyed on the run's OWN repository owner. This is the
    // billing fact itself ("who does GitHub charge?"), not a Motir column that
    // could drift from it, and reading it from the RUN rather than the mirror is
    // what makes the transfer edge (§5.5, MOTIR-711) need no special handling:
    // the owner changes at the transfer, so the next run simply falls outside.
    if (!isMotirOwnedRepo(event.repoOwner)) {
      return { outcome: 'not_metered', reason: 'foreign_owner' };
    }

    // 3 · §5.2 — resolve the tenant. THREE contexts, one per hop, because the
    // shipped RLS policies gate differently and only two of these tables carry
    // the `app.system_admin` escape:
    //
    //   * `github_installation` / `github_repo` — policy is
    //     `system_admin OR workspace_id = …`, so the webhook (no session, no
    //     active workspace) reads them under `withSystemContext`. This is the
    //     path the shipped PR/push/CI handlers already use.
    //   * `project_repository` / `workspace` — policy gates PURELY on
    //     `app.workspace_id` with NO system escape, so `withSystemContext` would
    //     read NOTHING here in production (where the app connects as the
    //     non-BYPASSRLS `motir_app` role) and the whole chain would silently
    //     resolve to "unattributed". They are read under
    //     `withWorkspaceServiceContext`, bound to the installation's workspace.
    //   * `organization` — `organization_active` gates purely on
    //     `app.organization_id`, likewise with no system escape, so `isMeta` is
    //     read under `withOrgServiceWriteContext`.
    //
    // A pleasant consequence: because the project-repo row is read under the
    // REPO's workspace GUC, RLS itself enforces that a repo can only be
    // attributed inside the tenant that owns it. A row belonging to another
    // workspace is invisible rather than merely unexpected, so cross-tenant
    // mis-attribution is structurally impossible, not just unlikely. (That is
    // also why the pre-MOTIR-1931 bug degraded to under-billing rather than
    // cross-tenant over-billing: bound to the WRONG tenant's GUC, the
    // `project_repository` read resolved nothing and the run fell into §5.4's
    // "metered as a cost, charged to nobody, and LOGGED" bucket.)
    const connection = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        installationId,
        tx,
      );
      if (!installation) return { kind: 'unknown_installation' as const };
      const repo = await githubRepoRepository.findByInstallationAndRepoId(
        installation.id,
        event.providerRepoId,
        tx,
      );
      if (!repo) return { kind: 'unknown_repo' as const };
      return {
        kind: 'connected' as const,
        // The REPO row is the payer (MOTIR-1931). The §5.1 owner-login gate above
        // still QUALIFIES the run — "does Motir pay GitHub for this?" — but it can
        // no longer IDENTIFY anyone: once every tenant's repos live in Motir's org
        // the owner login is true for all of them. The installation cannot answer
        // either; it is shared, and its `workspaceId` is NULL.
        workspaceId: repo.workspaceId,
        githubRepoId: repo.id,
      };
    });

    if (connection.kind === 'unknown_installation') return { outcome: 'unknown_installation' };
    if (connection.kind === 'unknown_repo') return { outcome: 'unknown_repo' };

    const tenant = await withWorkspaceServiceContext(connection.workspaceId, async (tx) => {
      // ⚠️ ATTRIBUTION, AND IT IS NO LONGER A LOOKUP (MOTIR-4648). This read used
      // to be `findByGithubRepoId`, justified by: *"`ProjectRepo.githubRepoId` is
      // @unique, so a realized repo belongs to AT MOST one project row — the join
      // can never be ambiguous."* The index is dropped and a repository in two
      // projects is the ordinary case, so the join CAN be ambiguous now.
      //
      // The disposition, and it refuses to guess:
      //   0 rows  → unattributed, exactly as before (§5.4's deleted-project /
      //             no-project case — the set row cascades away with its project).
      //   1 row   → that project. Unchanged, and still the overwhelmingly common
      //             shape.
      //   N rows  → the ORGANISATION still owns the spend and is still charged;
      //             the PROJECT is genuinely unknown, so it is recorded as null
      //             rather than as whichever row came back first. `projectId` is
      //             nullable on `ci_workflow_run_usage` precisely because "we
      //             know who pays but not which project" is a real state.
      //
      // Picking `rows[0]` would have been a one-word change and a plausible row
      // in the meter attributed to a project that may not have run anything.
      const projectRepos = await projectRepoRepository.listByGithubRepoId(
        connection.githubRepoId,
        tx,
      );
      if (projectRepos.length === 0) return null;
      // Every row realizing one repository is reachable from the same
      // installation, so the workspace is read off the first — what is ambiguous
      // is the PROJECT, not the tenant.
      const anchor = projectRepos[0]!;
      const workspace = await workspaceRepository.findByIdInTx(anchor.workspaceId, tx);
      if (!workspace) return null;
      if (projectRepos.length > 1) {
        console.warn(
          '[ciMinutesMeterService] repository is used by several projects — metering the org, project left null',
          { githubRepoId: connection.githubRepoId, projectCount: projectRepos.length },
        );
      }
      return {
        workspaceId: anchor.workspaceId,
        organizationId: workspace.organizationId,
        projectId: projectRepos.length === 1 ? anchor.projectId : null,
      };
    });

    const resolved = tenant
      ? {
          kind: 'resolved' as const,
          attribution: {
            workspaceId: tenant.workspaceId,
            organizationId: tenant.organizationId,
            projectId: tenant.projectId,
            githubRepoId: connection.githubRepoId,
            isMeta: await withOrgServiceWriteContext(tenant.organizationId, async (tx) => {
              const organization = await organizationRepository.findByIdInTx(
                tenant.organizationId,
                tx,
              );
              // A missing org row defaults to non-meta — the safe direction (it
              // meters rather than silently bypassing), as `resolveTenantOrg` does.
              return organization?.isMeta ?? false;
            }),
          } satisfies Attribution,
        }
      : { kind: 'unattributed' as const };

    if (resolved.kind === 'unattributed') {
      // §5.4: "metered as a cost, charged to nobody, and LOGGED". Motir is still
      // billed by GitHub for this run; the log is the only signal that real spend
      // has no owner, and silence would hide it.
      console.warn(
        '[ciMinutesMeterService] Motir-owned repo has no attributable project — real CI spend charged to nobody',
        {
          repoOwner: event.repoOwner,
          repoName: event.repoName,
          runId: event.runId,
          runAttempt: event.attempt,
        },
      );
      return { outcome: 'unattributed', repoOwner: event.repoOwner, repoName: event.repoName };
    }

    const attribution = resolved.attribution;

    // 4 · §4.4 — the META org is bypassed entirely: no pool accounting, no
    // overage, no refusal. moooon B.V. pays its own GitHub bill directly, so
    // metering it would bill the house to itself. Mirrors the shipped credit-gate
    // and `meta`-tier bypasses.
    if (attribution.isMeta) {
      return { outcome: 'bypassed_meta', organizationId: attribution.organizationId };
    }

    // 5 · A cheap redelivery pre-check, purely to skip the GitHub round-trip.
    // NOT the correctness guard — two concurrent deliveries would both miss it;
    // the `(run_id, run_attempt)` unique index at step 7 is what guarantees once.
    const already = await withSystemContext((tx) =>
      ciWorkflowRunUsageRepository.findByRunAndAttempt(event.runId, event.attempt, tx),
    );
    if (already) {
      return { outcome: 'duplicate', runId: event.runId, runAttempt: event.attempt };
    }

    // 6 · §5.8 — read the run's JOBS and normalize. Per-job `ceil` is not
    // optional: GitHub bills per job rounded up, and a workflow's jobs run in
    // parallel, so the run's own wall clock would badly undercount a 4-job suite.
    const provider = getGitProvider(PROVIDER);
    // The capability is OPTIONAL on the seam (§5.6 — GitLab has no Motir-paid
    // compute to report), but `PROVIDER` is the literal `'github'`, which always
    // implements it. Asserted rather than guarded: a defensive branch here could
    // never be reached or tested honestly, and if a future edit did break the
    // invariant the resulting TypeError is caught by the webhook's own handler,
    // which logs it and acks — the same treatment any other metering failure gets.
    const jobs = await provider.fetchWorkflowRunJobs!(
      installationId,
      event.repoOwner,
      event.repoName,
      event.runId,
      event.attempt,
    );

    const usage = normalizeRunUsage(jobs as MeteredJob[], event.completedAt);
    if (usage.billableMinutes === 0) {
      return { outcome: 'no_billable_jobs', runId: event.runId };
    }
    if (usage.unpricedFamilies.length > 0) {
      // §3.4 — an unpriced runner meters at ×1.00 (under-counting is the safe
      // direction: it never over-bills for a rate nobody decided) and LOGS. This
      // entry is the signal to add an effective-dated rate.
      console.warn('[ciMinutesMeterService] unpriced runner family metered at x1.00', {
        families: usage.unpricedFamilies,
        runId: event.runId,
        repoOwner: event.repoOwner,
        repoName: event.repoName,
      });
    }

    // 7 · §4.5 — the period is a PURE function of the run's completion instant,
    // so the write reads no billing state at all.
    const periodStart = periodStartFor(event.completedAt);

    try {
      await withSystemContext(async (tx) => {
        await ciWorkflowRunUsageRepository.create(
          {
            workspaceId: attribution.workspaceId,
            organizationId: attribution.organizationId,
            projectId: attribution.projectId,
            githubRepoId: attribution.githubRepoId,
            runId: event.runId,
            runAttempt: event.attempt,
            repoOwner: event.repoOwner,
            repoName: event.repoName,
            workflowName: event.workflowName,
            periodStart,
            runCompletedAt: event.completedAt,
            billableMinutes: usage.billableMinutes,
            rawWallClockSeconds: usage.rawWallClockSeconds,
            linearEquivalentMinutes: usage.linearEquivalentMinutes,
            jobCount: usage.jobCount,
            runnerBreakdown: usage.breakdown as unknown as Prisma.InputJsonValue,
          },
          tx,
        );
        await ciPeriodUsageRepository.incrementForPeriod(
          {
            workspaceId: attribution.workspaceId,
            organizationId: attribution.organizationId,
            periodStart,
            billableMinutes: usage.billableMinutes,
            rawWallClockSeconds: usage.rawWallClockSeconds,
            linearEquivalentMinutes: usage.linearEquivalentMinutes,
          },
          tx,
        );
      });
    } catch (err) {
      // The idempotency guarantee. A concurrent or retried delivery loses the
      // race on `(run_id, run_attempt)`; because the rollup increment shares this
      // transaction, it rolls back WITH the failed insert — so a duplicate can
      // never inflate the period total. Caught OUTSIDE the transaction on
      // purpose: a failed statement aborts the Postgres transaction, so catching
      // it inside and continuing would only produce a second, more confusing
      // error (25P02).
      if (isUniqueViolation(err)) {
        return { outcome: 'duplicate', runId: event.runId, runAttempt: event.attempt };
      }
      throw err;
    }

    return {
      outcome: 'metered',
      runId: event.runId,
      runAttempt: event.attempt,
      organizationId: attribution.organizationId,
      workspaceId: attribution.workspaceId,
      projectId: attribution.projectId,
      periodStart,
      billableMinutes: usage.billableMinutes,
      linearEquivalentMinutes: usage.linearEquivalentMinutes,
    };
  },

  /**
   * THE SEAM (§Consequences: "the seam between them is one read"). How many
   * Linux-equivalent minutes has this org consumed in the period containing
   * `at`? MOTIR-1901 measures its `max(members × 300, 1000)` pool against
   * exactly this and nothing else.
   *
   * Deliberately returns consumption ONLY — no pool, no balance, no verdict.
   * Those are the entitlement's, and keeping them out of the meter is what lets
   * this half stay a pure measurement with no billing coupling.
   */
  async getOrgPeriodConsumption(organizationId: string, at: Date): Promise<OrgPeriodConsumption> {
    return withSystemContext((tx) =>
      ciPeriodUsageRepository.sumForOrgPeriod(organizationId, periodStartFor(at), tx),
    );
  },

  /**
   * Per-repository metered totals for an org's period — what the monthly
   * reconciliation (§5.8) compares against GitHub's own billing report.
   */
  async getOrgPeriodTotalsByRepo(organizationId: string, at: Date): Promise<RepoPeriodTotal[]> {
    const periodStart = periodStartFor(at);
    return withSystemContext((tx) =>
      ciWorkflowRunUsageRepository.sumByRepoForOrgPeriod(
        organizationId,
        periodStart,
        periodEndFor(periodStart),
        tx,
      ),
    );
  },

  /** Motir's provisioning org login, re-exported so the reconciliation job and
   *  tests read the same configured value the §5.1 gate does. */
  provisioningOrg(): string | null {
    return provisioningOrgLogin();
  },
};

/** A Postgres unique-constraint violation, surfaced by Prisma as P2002. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
