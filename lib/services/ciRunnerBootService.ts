import type { CiRunnerProvisioningIntent, Prisma } from '@prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  ciRunnerProvisioningIntentRepository as intents,
  CI_RUNNER_INTENT_COMPLETED,
  CI_RUNNER_INTENT_FAILED,
} from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import {
  ciRunnerAdmissionService,
  type AdmissionDeferralReason,
} from '@/lib/services/ciRunnerAdmissionService';
import {
  projectRunnerGroupService,
  RunnerGroupNotProvisionedError,
} from '@/lib/services/projectRunnerGroupService';
import {
  runnerJitConfigClient,
  RunnerRegistrationRateLimitedError,
} from '@/lib/github/runnerJitConfig';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { getOrchestrator, isOrchestratorConfigured } from '@/lib/orchestrator';
import { flyFleetConfig } from '@/lib/orchestrator/adapters/fly/flyMachines';
import { FLEET_CONTAINER_SIZE } from '@/lib/orchestrator/rates';
import { recordContainerUsage } from '@/lib/orchestrator/usageSink';
import type {
  ContainerHandle,
  ContainerOrchestrator,
  ContainerSpec,
  ContainerUsage,
  TeardownReason,
  UsageAttribution,
} from '@/lib/orchestrator/types';

// THE PROVISIONER (Story MOTIR-1916 · MOTIR-1921) — one provisioning intent
// becomes exactly one single-use ephemeral runner, and is guaranteed to stop
// costing money afterwards.
//
// `docs/decisions/ci-runner-fleet.md` §10 scopes this card: the port, the Fly
// adapter, the fake adapter, `reap()` and its schedule. This service is what
// drives them.
//
// ⚠️ TEARDOWN IS THE CORRECTNESS PROPERTY, NOT BOOT. Boot failing is visible and
// cheap — a job queues and someone notices. Teardown failing is invisible and
// bills forever. So the shape of this file is deliberately lopsided: the boot is
// a handful of straight-line calls, and everything else is the four independent
// mechanisms that make sure nothing survives it.
//
//   1. The JIT CONFIG — the runner takes exactly one job, de-registers, exits.
//   2. `auto_destroy: true` + `restart: { policy: 'no' }` in the Fly adapter — an
//      exiting process is a destroyed machine, not a restarted one.
//   3. THE `finally` IN {@link ciRunnerBootService.runIntent} — every path out of
//      supervision tears the container down, including the ones that threw.
//   4. {@link ciRunnerBootService.reapOrphans} — the backstop for the ONE case a
//      `finally` cannot cover: this process dying between provision and teardown.
//
// They are independent on purpose. Any one of them can fail without leaking a
// container, which is the only useful definition of "guaranteed" for something
// whose failure is silent.
//
// ⚠️ WHO DECIDES WHETHER THIS RUNS AT ALL. §10 puts the ADMISSION GATE — the
// per-project in-flight cap, the fleet-wide ceiling and the
// `ci_credits_exhausted` refusal — in MOTIR-1922, "consulted BEFORE this card
// provisions". It has landed as `ciRunnerAdmissionService`, and {@link
// ciRunnerBootService.runIntent} consults it EXACTLY WHERE THE CLAIM USED TO BE:
// the gate decides and claims in one locked transaction, because the claim is
// what makes an intent count as in-flight and a gate that did not own it would be
// deciding from a count that excludes the decisions already made. This service
// still reads no cap, no ceiling and no balance itself — it asks, and it obeys.
//
// The pending-intent sweep below remains the trigger. It is honest but slow (a
// minute-granularity cron cannot meet §6's ≤30s p50 budget); a hot-path call from
// the `workflow_job` webhook straight to this service is the remaining half of
// that budget and is tracked as its own card.

/** How long a container has to reach a running state before it is written off as
 *  a boot that never happened. §6 budgets p95 ≤ 60s end to end; double that is a
 *  deadline that cannot fire on a merely-slow boot. */
const DEFAULT_BOOT_DEADLINE_MS = 120_000;

/** The hard kill. GitHub's own ceiling is a 5-day job; a CI job that has not
 *  finished in an hour on 2-core hardware is not going to, and every further
 *  second is billed to Motir. §11 leaves what happens to the JOB (re-queue,
 *  surface, leave it to the user's re-run) to the fleet's operational story; what
 *  is fixed here is that the CONTAINER stops. */
const DEFAULT_JOB_TIMEOUT_MS = 3_600_000;

/** How often supervision asks the provider what the container is doing. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

/**
 * How many CONSECUTIVE provider status reads may fail before supervision gives
 * up and tears the container down.
 *
 * Not zero, because a single 500 from the provider would otherwise end a
 * customer's healthy CI run for a reason that has nothing to do with their code.
 * Not unbounded, because a provider that is genuinely unreachable must not leave
 * this loop watching a container forever — and the deadlines still bound it
 * either way, since a failed read falls through to the same checks.
 */
const MAX_CONSECUTIVE_READ_FAILURES = 3;

/** How long a claimed-but-never-booted intent may sit before the sweep writes it
 *  off and de-registers its runner. Comfortably past the boot deadline, so a
 *  slow-but-live provision is never swept out from under itself. */
const STALE_CLAIM_MS = 15 * 60_000;

/** How old a container must be before the reaper destroys it. Past the job
 *  timeout, so the reaper only ever sees containers the `finally` genuinely
 *  failed to reach — not ones it is about to. */
const DEFAULT_REAP_AFTER_MS = DEFAULT_JOB_TIMEOUT_MS + 10 * 60_000;

/** Seams the tests drive. Defaults are the constants above; nothing else may
 *  pass them, which is why they are optional and undocumented in the API. */
export interface SupervisionOptions {
  bootDeadlineMs?: number;
  jobTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export type RunIntentOutcome =
  /** No such intent — it was deleted, or the id was stale. */
  | { outcome: 'unknown_intent' }
  /** Another provisioner claimed it first. NOT an error: the compare-and-set
   *  worked exactly as intended. */
  | { outcome: 'already_claimed' }
  /** THE ADMISSION GATE (MOTIR-1922) declined. The intent is still PENDING and
   *  the next sweep retries it — a job left queued, never a job failed, which is
   *  what a cap is supposed to feel like. */
  | { outcome: 'gate_deferred'; reason: AdmissionDeferralReason; detail: string }
  /** This deployment provisions no containers (self-hosted, or unwired). The
   *  claim is RELEASED so a configured instance can take it. */
  | { outcome: 'not_configured' }
  /** GitHub's registration ceiling is exhausted. RETRYABLE — the claim is
   *  released and the intent stays pending for the next sweep. */
  | { outcome: 'rate_limited'; retryAfterSeconds: number | null }
  /** The intent names no project, so there is no runner group and no tenant to
   *  bill. Refused (§7.3), never provisioned into the `Default` group. */
  | { outcome: 'no_runner_group'; detail: string }
  /** The container never existed: the mint or the boot was refused. */
  | { outcome: 'provision_failed'; detail: string }
  /** A container ran and was torn down. `reason` says how it ended. */
  | {
      outcome: 'settled';
      reason: TeardownReason;
      containerId: string;
      billableSeconds: number;
      costUsd: string;
      bootLatencyMs: number | null;
      /** The §5 container-seconds record. Carried on the outcome so it reaches
       *  the `job_run` ledger, which stays the PER-RUN operational trail; since
       *  MOTIR-1924 the same record is also persisted to `ci_container_usage`
       *  by the sink, which is where it is queryable and attributed. */
      usage: ContainerUsage;
    };

function sleepFor(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

export const ciRunnerBootService = {
  /**
   * {@link runIntent}, ONCE PER DISPATCH — the entrypoint the boot job calls
   * (MOTIR-2002).
   *
   * ⚠️ WHY A MEMO AND NOT A STEP. Inngest re-invokes a handler from the top at
   * every step boundary, so anything OUTSIDE a `ctx.step.run` executes once per
   * durable-replay PASS, and the number of passes is a function of how many
   * steps the run happens to take — `defineJob`'s two ledger writes make it two.
   * The obvious fix is to wrap the supervision in a step, whose memoization is
   * exactly the once-only semantics wanted; it is unavailable, and measurably
   * so. One step cannot outlive ONE INVOCATION of `app/api/inngest/route.ts`,
   * whose declared budget is `maxDuration = 300` (Vercel's serverless maximum on
   * the Pro plan, fixed there by MOTIR-1974), while {@link DEFAULT_JOB_TIMEOUT_MS}
   * lets a supervised CI job run for 3,600s — twelve times the ceiling.
   *
   * So the supervision stays un-stepped and is made explicitly replay-aware
   * instead: the pass that does the work records its outcome on the intent, and
   * every later pass of the SAME dispatch reads it back. Later passes cost one
   * indexed read and neither re-admit (the fleet-wide admission lock is taken
   * once per boot, not twice) nor re-report (Inngest's run output is the real
   * outcome, not the loser's `already_claimed`).
   *
   * `supervisionKey` identifies the dispatch — the triggering event's id, which
   * is fixed for a run. It is MATCHED, not merely recorded: a second dispatch for
   * the same intent gets its own honest `already_claimed` rather than inheriting
   * a container it never booted.
   *
   * Not a substitute for the claim. `admit`'s atomic `pending → provisioning`
   * remains the guarantee that no second container is ever booted; this is what
   * stops the fleet's money safety from resting on it ALONE.
   */
  async superviseOnce(
    intentId: string,
    supervisionKey: string,
    options: SupervisionOptions = {},
  ): Promise<RunIntentOutcome> {
    const replayed = await readSupervisionMemo(intentId, supervisionKey);
    if (replayed) return replayed;

    const outcome = await this.runIntent(intentId, options);
    await recordSupervisionMemo(intentId, supervisionKey, outcome);
    return outcome;
  },

  /**
   * Turn ONE provisioning intent into ONE ephemeral runner, supervise it, and
   * guarantee it is gone.
   *
   * Never throws for an outcome it can name — every refusal is a typed result the
   * caller logs — because the caller is a background job, and a job that throws
   * gets retried by Inngest. Retrying "this project has no runner group" would
   * mint and de-register a runner four more times for nothing.
   */
  async runIntent(intentId: string, options: SupervisionOptions = {}): Promise<RunIntentOutcome> {
    const now = options.now ?? (() => new Date());
    const sleep = options.sleep ?? sleepFor;
    const bootDeadlineMs = options.bootDeadlineMs ?? DEFAULT_BOOT_DEADLINE_MS;
    const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    const intent = await withSystemContext((tx) => intents.findById(intentId, tx));
    if (!intent) return { outcome: 'unknown_intent' };

    if (!isOrchestratorConfigured()) return { outcome: 'not_configured' };

    // THE ADMISSION GATE, which also takes THE CLAIM (atomic `pending →
    // provisioning`; the loser simply stops — see `claimPending` for why the
    // predicate is the whole guard). Nothing below this line is reachable for an
    // intent the caps or the credit state declined, which is the point: every
    // line after it costs money.
    const verdict = await ciRunnerAdmissionService.admit(intent);
    if (verdict.outcome === 'already_claimed') return { outcome: 'already_claimed' };
    if (verdict.outcome === 'deferred') {
      console.warn('[ciRunnerBootService] the admission gate deferred an intent', {
        intentId,
        reason: verdict.reason,
        detail: verdict.detail,
      });
      return { outcome: 'gate_deferred', reason: verdict.reason, detail: verdict.detail };
    }

    // ── Everything the boot needs, resolved before anything is spent ──────────
    if (!intent.projectId) {
      // No project means no runner group (§7.3) and no tenant the container's
      // cost could be attributed to. Both are disqualifying on their own.
      await settleFailed(intentId, 'provision_failed', 'the intent names no project');
      return { outcome: 'no_runner_group', detail: 'the intent names no project' };
    }

    const workflowJobId = Number(intent.jobId);
    if (!Number.isInteger(workflowJobId) || workflowJobId <= 0) {
      await settleFailed(intentId, 'provision_failed', 'the intent has a malformed job id');
      return { outcome: 'provision_failed', detail: 'the intent has a malformed job id' };
    }

    let runnerGroupId: number;
    try {
      // ⚠️ REFUSES rather than falling back. §7.3: never the `Default` group (id
      // 1, `visibility: "all"`), which would silently restore the cross-tenant
      // pickup the per-project group exists to prevent — a runner booted for
      // project X taking project Y's job, including one the gate DECLINED.
      runnerGroupId = await projectRunnerGroupService.requireRunnerGroupId({
        projectId: intent.projectId,
        workspaceId: intent.workspaceId,
      });
    } catch (err) {
      const detail =
        err instanceof RunnerGroupNotProvisionedError
          ? err.message
          : `could not read the project's runner group: ${detailOf(err)}`;
      await settleFailed(intentId, 'provision_failed', detail);
      return { outcome: 'no_runner_group', detail };
    }

    let orchestrator: ContainerOrchestrator;
    try {
      orchestrator = getOrchestrator();
    } catch (err) {
      await releaseClaim(intentId);
      console.warn('[ciRunnerBootService] no orchestrator is configured — claim released', {
        intentId,
        detail: detailOf(err),
      });
      return { outcome: 'not_configured' };
    }

    // ── 1 · Mint the JIT config ───────────────────────────────────────────────
    // The credential the container receives. ONE runner, ONE config, no
    // registration capability inside the container (§7.4).
    let jit;
    try {
      jit = await runnerJitConfigClient.mint({
        name: runnerNameFor(intent),
        runnerGroupId,
        // EXACTLY the one §M-compliant label. Not `self-hosted`, not `linux`, not
        // `x64`: a runner carrying GitHub's defaults would match some unrelated
        // tenant's `runs-on: self-hosted`, which is §7.3's cross-tenant pickup
        // arriving through the label axis instead of the group axis.
        labels: [MOTIR_RUNNER_LABEL],
      });
    } catch (err) {
      if (err instanceof RunnerRegistrationRateLimitedError) {
        // Early, not broken. Release the claim and let the next sweep try — a
        // burst against GitHub's 1,500-per-5-minutes ceiling is the gate's
        // problem to shape (§6), not a reason to fail a job.
        await releaseClaim(intentId);
        return { outcome: 'rate_limited', retryAfterSeconds: err.retryAfterSeconds };
      }
      const detail = `could not mint a JIT config: ${detailOf(err)}`;
      await settleFailed(intentId, 'provision_failed', detail);
      return { outcome: 'provision_failed', detail };
    }

    // Persist the runner id BEFORE booting. `generate-jitconfig` has already
    // registered the runner (§7.4), so from here on a crash without this column
    // would leave a dangling registered runner nobody can name.
    await withSystemContext((tx) =>
      intents.recordMintedRunner(
        intentId,
        { githubRunnerId: jit.runnerId, runnerName: jit.runnerName },
        tx,
      ),
    );

    // ── 2 · Boot exactly one container ────────────────────────────────────────
    const spec = this.buildSpec({
      intent,
      workflowJobId,
      projectId: intent.projectId,
      encodedJitConfig: jit.encodedJitConfig,
      timeoutSeconds: Math.ceil(jobTimeoutMs / 1000),
      orchestrator,
    });

    let handle: ContainerHandle;
    try {
      handle = await orchestrator.provision(spec);
    } catch (err) {
      // A MINTED-BUT-UNUSED JIT CONFIG. The runner is registered at GitHub and no
      // container will ever claim it, so it is de-registered here rather than
      // left to GitHub — which does not clean it up (§7.4, verified).
      await deregisterQuietly(jit.runnerId, intentId);
      const detail = `could not boot a container: ${detailOf(err)}`;
      await settleFailed(intentId, 'provision_failed', detail);
      return { outcome: 'provision_failed', detail };
    }

    const bootedAt = now();
    await withSystemContext((tx) =>
      intents.recordBoot(
        intentId,
        {
          containerProvider: handle.provider,
          containerId: handle.id,
          containerRegion: handle.region,
          githubRunnerId: jit.runnerId,
          runnerName: jit.runnerName,
          bootedAt,
        },
        tx,
      ),
    );

    // ── 3 · Supervise, and tear down on EVERY path out ────────────────────────
    const attribution: UsageAttribution = {
      orgId: intent.organizationId,
      workspaceId: intent.workspaceId,
      projectId: intent.projectId,
      repoFullName: `${intent.repoOwner}/${intent.repoName}`,
      workflowJobId,
      size: FLEET_CONTAINER_SIZE,
      observedStartedAt: null,
    };

    let reason: TeardownReason = 'provision_failed';
    let observedStartedAt: Date | null = null;
    let bootLatencyMs: number | null = null;
    let supervisionError: string | null = null;

    try {
      const supervised = await supervise({
        orchestrator,
        handle,
        bootedAt,
        queuedAt: intent.queuedAt,
        bootDeadlineMs,
        jobTimeoutMs,
        pollIntervalMs,
        now,
        sleep,
      });
      reason = supervised.reason;
      observedStartedAt = supervised.startedAt;
      bootLatencyMs = supervised.bootLatencyMs;
      if (supervised.startedAt && supervised.bootLatencyMs !== null) {
        await withSystemContext((tx) =>
          intents.recordStarted(
            intentId,
            supervised.startedAt as Date,
            supervised.bootLatencyMs as number,
            tx,
          ),
        );
      }
    } catch (err) {
      // The supervision loop itself broke — a provider read failed repeatedly, or
      // something unforeseen threw. The container still exists, so the ONLY
      // acceptable next step is the `finally` below.
      supervisionError = detailOf(err);
      reason = 'job_timed_out';
    } finally {
      // ⚠️ THE GUARANTEE. Every path out of supervision arrives here — success,
      // timeout, never-started, and a throw. `teardown` is idempotent, so the
      // reaper reaching the same container later is harmless.
      const usage = await teardownQuietly(orchestrator, handle, reason, {
        ...attribution,
        observedStartedAt,
      });
      await deregisterQuietly(jit.runnerId, intentId);

      if (usage) {
        await recordContainerUsage(usage);
        await settleIntent(intentId, {
          status: reason === 'job_completed' ? CI_RUNNER_INTENT_COMPLETED : CI_RUNNER_INTENT_FAILED,
          teardownReason: reason,
          settledAt: now(),
          failureDetail: supervisionError,
          startedAt: observedStartedAt,
          bootLatencyMs,
        });
        return {
          outcome: 'settled',
          reason,
          containerId: handle.id,
          billableSeconds: usage.billableSeconds,
          costUsd: usage.costUsd,
          bootLatencyMs,
          usage,
        };
      }

      // Teardown itself failed. The intent stays IN FLIGHT deliberately: marking
      // it settled would hide a container that may still be running from the one
      // mechanism that can still catch it. The reaper owns it now.
      console.error(
        '[ciRunnerBootService] teardown failed — the intent is left in flight for the reaper',
        { intentId, containerId: handle.id, provider: handle.provider },
      );
      return {
        outcome: 'provision_failed',
        detail: `teardown failed for container ${handle.id}; left for the reaper`,
      };
    }
  },

  /**
   * THE REAPER (§4, §7.1's third guarantee). Destroy every fleet container older
   * than `olderThan`, whatever Motir's own tables believe, and settle the intents
   * that were holding them.
   *
   * ⚠️ IT QUERIES THE ORCHESTRATOR AGAINST THE INTENT TABLE, NEVER IN-PROCESS
   * STATE — the card's wording, and the reason is that the case it exists for is
   * the process that HELD that state having died. The provider is asked what
   * exists; the intent table is consulted only to attribute what came back.
   */
  async reapOrphans(
    options: { olderThan?: Date; now?: () => Date } = {},
  ): Promise<{ reaped: number; staleClaims: number; usages: ContainerUsage[] }> {
    if (!isOrchestratorConfigured()) return { reaped: 0, staleClaims: 0, usages: [] };
    const now = options.now ?? (() => new Date());
    const olderThan = options.olderThan ?? new Date(now().getTime() - DEFAULT_REAP_AFTER_MS);

    const orchestrator = getOrchestrator();
    const usages = await orchestrator.reap(olderThan, async (handle) => {
      const intent = await withSystemContext((tx) =>
        intents.findByContainerId(handle.provider, handle.id, tx),
      );
      if (!intent || !intent.projectId) return null;
      const workflowJobId = Number(intent.jobId);
      if (!Number.isInteger(workflowJobId)) return null;
      return {
        orgId: intent.organizationId,
        workspaceId: intent.workspaceId,
        projectId: intent.projectId,
        repoFullName: `${intent.repoOwner}/${intent.repoName}`,
        workflowJobId,
        size: FLEET_CONTAINER_SIZE,
        // A reaped container's start instant is whatever the provider still
        // reports; this process never observed it (that is what made it an
        // orphan), so there is nothing honest to fall back to.
        observedStartedAt: intent.startedAt,
      };
    });

    for (const usage of usages) {
      await recordContainerUsage(usage);
      const intent = await withSystemContext((tx) =>
        intents.findByContainerId(usage.provider, usage.handleId, tx),
      );
      if (!intent) continue;
      await deregisterQuietly(intent.githubRunnerId, intent.id);
      await settleIntent(intent.id, {
        status: CI_RUNNER_INTENT_FAILED,
        teardownReason: 'reaped',
        settledAt: now(),
        failureDetail: 'the container outlived its supervisor and was reaped',
      });
    }

    const staleClaims = await sweepStaleClaims(now);
    // The records ride out on the return value, into the `job_run` ledger.
    return { reaped: usages.length, staleClaims, usages };
  },

  /**
   * The provisioning SPEC for one intent — the port's provider-neutral shape.
   *
   * Exported (rather than inlined) because it is what MOTIR-1927's label-scoping
   * guard asserts against: the env the container receives, the single label the
   * JIT config was minted with, and the size §M fixes are all decided here, in
   * one readable place, and none of them is a Fly concept.
   */
  buildSpec(input: {
    intent: CiRunnerProvisioningIntent;
    workflowJobId: number;
    projectId: string;
    encodedJitConfig: string;
    timeoutSeconds: number;
    orchestrator: ContainerOrchestrator;
  }): ContainerSpec {
    const { intent, workflowJobId, projectId, encodedJitConfig, timeoutSeconds } = input;
    // The image and region are the Fly deployment's, but they are read through
    // the CONFIG accessor rather than the adapter's API surface, so the spec
    // stays provider-neutral. On the fake adapter neither is set, and the
    // defaults keep the spec well-formed.
    let image = 'motir/ci-runner@sha256:unset';
    let region = 'iad';
    try {
      const config = flyFleetConfig();
      image = config.image;
      region = config.region;
    } catch {
      // Not configured — the fake adapter path. The spec is still complete, and
      // the caller has already established that an orchestrator exists.
    }

    return {
      orgId: intent.organizationId,
      workspaceId: intent.workspaceId,
      projectId,
      repoFullName: `${intent.repoOwner}/${intent.repoName}`,
      workflowJobId,
      image,
      size: FLEET_CONTAINER_SIZE,
      timeoutSeconds,
      region,
      env: {
        // The credential, injected at boot and never baked into the image (§4).
        ACTIONS_RUNNER_INPUT_JITCONFIG: encodedJitConfig,
        // ⚠️ `--no-default-labels`, which the card requires the boot to name.
        // The REAL guarantee is the JIT config: its `labels` array is the
        // runner's complete label set and GitHub adds no defaults to a JIT
        // runner. This flag is the second, independent statement of the same
        // requirement — the one that would still hold if the runner image ever
        // fell back to a `config.sh` path, where GitHub WOULD add
        // `self-hosted`/`Linux`/`X64` and a fleet runner would start matching
        // other tenants' `runs-on: self-hosted`.
        ACTIONS_RUNNER_CONFIG_ARGS: '--no-default-labels',
        MOTIR_RUNNER_LABEL,
        MOTIR_INTENT_ID: intent.id,
        MOTIR_WORKFLOW_JOB_ID: String(workflowJobId),
      },
    };
  },

  /** The pending-intent sweep — the interim trigger (see the module header: the
   *  hot path is MOTIR-1922's). Returns what it dispatched so the job can log it. */
  async listRunnableIntentIds(limit = 25): Promise<string[]> {
    if (!isOrchestratorConfigured()) return [];
    const pending = await withSystemContext((tx) => intents.listPending(limit, tx));
    return pending.map((intent) => intent.id);
  },
};

// ── internals ─────────────────────────────────────────────────────────────

/**
 * Watch one container until it finishes, never starts, or overruns.
 *
 * Two deadlines, not one, because they are different failures with different
 * remedies: a container that never STARTS is a boot problem (a bad image, an
 * exhausted region), while one that starts and never STOPS is a job problem (a
 * hung test, an infinite loop in customer code). Collapsing them into a single
 * timeout would make the fleet's most common two failures indistinguishable in
 * the record.
 */
async function supervise(input: {
  orchestrator: ContainerOrchestrator;
  handle: ContainerHandle;
  bootedAt: Date;
  queuedAt: Date;
  bootDeadlineMs: number;
  jobTimeoutMs: number;
  pollIntervalMs: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ reason: TeardownReason; startedAt: Date | null; bootLatencyMs: number | null }> {
  const { orchestrator, handle, bootedAt, queuedAt, now, sleep } = input;
  let startedAt: Date | null = null;
  let bootLatencyMs: number | null = null;
  let consecutiveReadFailures = 0;

  for (;;) {
    // ⚠️ A SINGLE PROVIDER BLIP MUST NOT KILL A CUSTOMER'S JOB. Without this
    // tolerance one 500 from the provider propagates out of the loop, the
    // `finally` tears the container down, and a healthy CI run dies mid-test for
    // a reason that has nothing to do with the customer's code. The deadlines
    // above are still the real bound — this only buys the loop the right to
    // MISS a few reads, never the right to run longer.
    let status;
    try {
      status = await orchestrator.describe(handle);
      consecutiveReadFailures = 0;
    } catch (err) {
      consecutiveReadFailures += 1;
      if (consecutiveReadFailures > MAX_CONSECUTIVE_READ_FAILURES) throw err;
      console.warn('[ciRunnerBootService] a container status read failed — retrying', {
        containerId: handle.id,
        provider: handle.provider,
        consecutiveReadFailures,
        detail: detailOf(err),
      });
      // Fall through to the deadline checks with the reads we have, so a
      // provider that is down cannot extend a container past its timeout.
      const elapsedSoFar = now().getTime() - bootedAt.getTime();
      if (!startedAt && elapsedSoFar >= input.bootDeadlineMs) {
        return { reason: 'provision_failed', startedAt: null, bootLatencyMs: null };
      }
      if (elapsedSoFar >= input.jobTimeoutMs) {
        return { reason: 'job_timed_out', startedAt, bootLatencyMs };
      }
      await sleep(input.pollIntervalMs);
      continue;
    }

    if (status.startedAt && !startedAt) {
      startedAt = status.startedAt;
      // ⚠️ MEASURED FROM `queuedAt`, GitHub's own instant — not from our
      // receipt of the webhook and not from the boot. §6's budget is the span a
      // USER experiences as "CI is slow to start", and the queue time before
      // Motir even heard about the job is part of that. MOTIR-1928 measures the
      // real p50/p95 against the budget; this is what makes it a query.
      bootLatencyMs = Math.max(0, startedAt.getTime() - queuedAt.getTime());
    }

    if (status.terminal) {
      // Gone or stopped. If it never started, the runner never registered — the
      // "boot succeeded but nothing came up" path, which is a provisioning
      // failure even though the provider reported success.
      return {
        reason: startedAt || status.startedAt ? 'job_completed' : 'provision_failed',
        startedAt: startedAt ?? status.startedAt,
        bootLatencyMs,
      };
    }

    const elapsed = now().getTime() - bootedAt.getTime();
    if (!startedAt && elapsed >= input.bootDeadlineMs) {
      return { reason: 'provision_failed', startedAt: null, bootLatencyMs: null };
    }
    if (elapsed >= input.jobTimeoutMs) {
      return { reason: 'job_timed_out', startedAt, bootLatencyMs };
    }

    await sleep(input.pollIntervalMs);
  }
}

/**
 * The outcome THIS dispatch already recorded for this intent, if any.
 *
 * ⚠️ FAILS OPEN. A memo that cannot be read must never be the reason a queued CI
 * job gets no runner, so a read failure falls through to supervising — which is
 * precisely the pre-MOTIR-2002 behaviour, still guarded by the claim. The log is
 * what distinguishes "no memo" from "could not tell".
 */
async function readSupervisionMemo(
  intentId: string,
  supervisionKey: string,
): Promise<RunIntentOutcome | null> {
  let recorded: Prisma.JsonValue | null;
  try {
    recorded = await withSystemContext((tx) =>
      intents.findSupervisionOutcome(intentId, supervisionKey, tx),
    );
  } catch (err) {
    console.error('[ciRunnerBootService] could not read the supervision memo — supervising', {
      intentId,
      detail: detailOf(err),
    });
    return null;
  }
  if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded)) return null;
  // The JSON PROJECTION of the outcome — the same round-trip `defineJob` applies
  // before writing `job_run.output`, so the replayed value and the ledger row are
  // the same value by construction (a `usage` Date arrives as an ISO string on
  // both surfaces, and only on the replayed passes).
  return recorded as unknown as RunIntentOutcome;
}

/** Record what this dispatch's supervision returned, so its replay passes read it
 *  back instead of re-deriving it. Best-effort for the same reason the teardown
 *  bookkeeping is: this runs AFTER a container has been booted and torn down, and
 *  throwing here would fail a run that already did its job correctly. */
async function recordSupervisionMemo(
  intentId: string,
  supervisionKey: string,
  outcome: RunIntentOutcome,
): Promise<void> {
  let serialized: Prisma.InputJsonValue;
  try {
    serialized = JSON.parse(JSON.stringify(outcome)) as Prisma.InputJsonValue;
  } catch {
    console.error('[ciRunnerBootService] a supervision outcome would not serialize', { intentId });
    return;
  }
  try {
    const written = await withSystemContext((tx) =>
      intents.recordSupervisionOutcome(intentId, supervisionKey, serialized, tx),
    );
    // No row to write to is EXPECTED for `unknown_intent` — there was nothing to
    // supervise, and a replay re-derives that same answer for free. Any other
    // outcome losing its memo means the replay will supervise again, so say so.
    if (!written && outcome.outcome !== 'unknown_intent') {
      console.warn('[ciRunnerBootService] the supervision memo wrote no row', {
        intentId,
        outcome: outcome.outcome,
      });
    }
  } catch (err) {
    console.error('[ciRunnerBootService] could not record the supervision memo', {
      intentId,
      detail: detailOf(err),
    });
  }
}

/** Tear down, swallowing a failure into null. The caller decides what a null
 *  means; what it must NOT do is propagate out of a `finally` and mask the
 *  reason the code got there. */
async function teardownQuietly(
  orchestrator: ContainerOrchestrator,
  handle: ContainerHandle,
  reason: TeardownReason,
  attribution: UsageAttribution,
) {
  try {
    return await orchestrator.teardown(handle, reason, attribution);
  } catch (err) {
    console.error('[ciRunnerBootService] could not tear down a container', {
      containerId: handle.id,
      provider: handle.provider,
      reason,
      detail: detailOf(err),
    });
    return null;
  }
}

/** De-register the GitHub runner. Idempotent and best-effort: on the happy path
 *  the ephemeral runner already de-registered itself and GitHub answers 404,
 *  which the client treats as success. */
async function deregisterQuietly(runnerId: number | null, intentId: string): Promise<void> {
  if (runnerId === null) return;
  try {
    await runnerJitConfigClient.deleteRunner(runnerId);
  } catch (err) {
    console.error(
      '[ciRunnerBootService] could not de-register a runner — it may be left dangling',
      { intentId, runnerId, detail: detailOf(err) },
    );
  }
}

async function settleIntent(
  intentId: string,
  record: {
    status: string;
    teardownReason: string | null;
    settledAt: Date;
    failureDetail: string | null;
    startedAt?: Date | null;
    bootLatencyMs?: number | null;
  },
): Promise<void> {
  try {
    await withSystemContext((tx) => intents.settle(intentId, record, tx));
  } catch (err) {
    console.error('[ciRunnerBootService] could not settle an intent', {
      intentId,
      detail: detailOf(err),
    });
  }
}

async function settleFailed(
  intentId: string,
  reason: TeardownReason,
  detail: string,
): Promise<void> {
  await settleIntent(intentId, {
    status: CI_RUNNER_INTENT_FAILED,
    teardownReason: reason,
    settledAt: new Date(),
    failureDetail: detail.slice(0, 300),
  });
}

/** Put a claimed intent back in the pending pool — for refusals that are about
 *  the ENVIRONMENT (unconfigured, rate-limited) rather than about the job. The
 *  gate releases the same way for a credit refusal, through the same repository
 *  method, so a re-queued intent looks identical whichever path re-queued it. */
async function releaseClaim(intentId: string): Promise<void> {
  await ciRunnerAdmissionService.releaseClaim(intentId);
}

/**
 * Intents claimed but never booted — the crash-between-mint-and-boot window.
 *
 * The container (if any) is the provider's problem and the reaper's; what is
 * left HERE is a registered GitHub runner with no machine, which is exactly the
 * dangling-JIT case §7.4 requires be de-registered rather than left. This is
 * where the `githubRunnerId` written before the boot earns its column.
 */
async function sweepStaleClaims(now: () => Date): Promise<number> {
  const claimedBefore = new Date(now().getTime() - STALE_CLAIM_MS);
  const stale = await withSystemContext((tx) => intents.listStaleClaims(claimedBefore, 50, tx));
  for (const intent of stale) {
    await deregisterQuietly(intent.githubRunnerId, intent.id);
    await settleIntent(intent.id, {
      status: CI_RUNNER_INTENT_FAILED,
      teardownReason: 'provision_failed',
      settledAt: now(),
      failureDetail: 'claimed but never booted; the minted runner was de-registered',
    });
  }
  return stale.length;
}

/**
 * The runner's NAME at GitHub. Deterministic and attributable, for the reason
 * `runnerGroupNameFor` is: an offline runner left in the org's list is traceable
 * to the job it was minted for with no reverse lookup.
 *
 * GitHub caps runner names at 64 characters, and a cuid intent id plus the prefix
 * fits comfortably — but it is truncated rather than trusted, because a name
 * GitHub refuses would fail the mint and queue the job for 24 hours.
 */
function runnerNameFor(intent: CiRunnerProvisioningIntent): string {
  return `motir-${intent.id}`.slice(0, 64);
}
