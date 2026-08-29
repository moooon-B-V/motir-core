/**
 * The WORKER ENTRYPOINT (Story MOTIR-3414 · Subtask MOTIR-3421).
 *
 * What `fly.toml`'s `worker` process group runs. It does four things and nothing
 * else: import the registry, start the loop, wire the signals, and stay up.
 *
 * As of MOTIR-3471 it also runs the SCHEDULER — the tick that turns a cron
 * expression into a `job_queue` row. It is not a fifth thing: the scheduler owns
 * no loop and no timer, and rides the claim loop this file already starts (see
 * `lib/jobs/engine/scheduler.ts` for why the poll, and not a `setTimeout` chain,
 * is the right driver). It adds no process, no machine and no environment
 * variable.
 *
 * It briefly also REPORTED a lane reconciliation at start-up (MOTIR-3716) — the
 * checked-in lane declaration against the live `MOTIR_POSTGRES_JOB_IDS`. Both went
 * with the second lane in MOTIR-3418: there is one engine now, so there is nothing
 * to route and nothing to reconcile.
 *
 * ⚠️ THE REGISTRY IMPORT BELOW IS LOAD-BEARING.
 * `JobScheduler.start()` REFUSES an empty registry rather than scheduling nothing
 * in silence, so deleting that import fails the process at start-up with a named
 * diagnosis instead of at run time with `UnknownEngineJobError`.
 *
 * ⚠️ IT LOOKS UNUSED AND IT IS NOT. `lib/jobs/engine/registry.ts`
 * is populated by `defineJob` as each definition MODULE is evaluated, so it holds
 * only the jobs something has imported. `lib/jobs/registry.ts` imports all 24
 * definition files, which is why importing it — for its side effect, not its
 * value — is what makes the engine's table complete. Deleting this import as
 * "unused" yields a worker that claims runs and cannot execute a single one,
 * with `UnknownEngineJobError` for every job id. `lib/jobs/schedules.ts` carries
 * the same warning for the same reason.
 *
 * ⚠️ IT IS BUNDLED, NOT RUN FROM SOURCE. `pnpm build:worker` esbuilds this file
 * and its transitive imports into one self-contained `.mjs`, which the Dockerfile
 * stages at `/app/worker/`. The runtime image is a Next.js STANDALONE bundle: its
 * `node_modules` is the minimal set Next traced for the SERVER's entries, and
 * `lib/` source arriving there at all is a tracing side effect the Dockerfile
 * explicitly refuses to depend on. So the worker brings its own bundle, exactly
 * as `/app/migrate` brings its own Prisma CLI, and for the same reason: a lane
 * that runs from the app's image must not inherit its files by accident.
 */
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { serverSentryInitOptions } from '@/lib/monitoring/serverInit';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { JobScheduler } from '@/lib/jobs/engine/scheduler';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { listenForQueuedJobs } from '@/lib/jobs/engine/notify';
// Side-effect import: evaluates every definition module so `defineJob` has
// registered every job. See the warning above — this is not an unused import.
import '@/lib/jobs/registry';

/**
 * ⚠️ THE E2E BOUNDARY SEAM, AND WHY IT IS INSTALLED HERE RATHER THAN IN
 * `instrumentation.ts` (Story MOTIR-3417 · MOTIR-3564).
 *
 * Every other external boundary in the E2E lane is stubbed by a
 * `lib/test-*-mock.ts` that `instrumentation.ts` installs behind a flag.
 * `instrumentation.ts` is a NEXT.JS HOOK: it runs once per Next server boot, and
 * this process is not a Next server — it is a plain Node bundle
 * (`pnpm build:worker`). So a seam registered there is invisible here.
 *
 * That matters for exactly one boundary and it is this story's: the index
 * SUPERVISOR mints a motir-ai run credential and resolves a GitHub tarball
 * redirect, and the supervisor is a JOB. The process that makes both calls is
 * this one. A seam installed only in the app server would leave the calls
 * un-stubbed where they actually happen — the MOTIR-3498 shape, one layer up
 * (there it was `EMAIL_PROVIDER` set on the webServer only, and every
 * engine-routed send went to the console provider while every signal stayed
 * green).
 *
 * DORMANT BY DEFAULT AND REFUSED OUTSIDE THE HARNESS. `installCodeGraphBoundaryMock`
 * requires BOTH `E2E_TEST_CODE_GRAPH=1` and `E2E_PROD_HARNESS=1` — the second is
 * set by `playwright.config.ts` and by no real deployment. The import is dynamic,
 * so a production worker never even loads `undici`'s mock machinery.
 */
async function installE2ESeams(): Promise<void> {
  // The LONG-RUNNING PROBE (MOTIR-3767) — its own flag, and checked FIRST so it
  // does not inherit the code-graph seam's early return. The two are independent
  // seams that happen to share this hook.
  const { slowJobEnabled } = await import('@/lib/test-slow-job');
  if (slowJobEnabled()) {
    const { registerSlowTestJob } = await import('@/lib/test-slow-job');
    registerSlowTestJob();
    console.info('[worker] E2E_TEST_SLOW_JOB active — the long-running probe is registered.');
  }

  // The SELF-RESCHEDULING PROBE (MOTIR-3832) — its own flag, and the same
  // independent-seam shape as the one above. It is a supervision rather than a
  // slow run: `lib/test-deferring-job.ts`'s header says why the two cannot be
  // one probe.
  const { deferringJobEnabled } = await import('@/lib/test-deferring-job');
  if (deferringJobEnabled()) {
    const { registerDeferringTestJob } = await import('@/lib/test-deferring-job');
    registerDeferringTestJob();
    console.info(
      '[worker] E2E_TEST_DEFERRING_JOB active — the self-rescheduling probe is registered.',
    );
  }

  const { codeGraphMockEnabled } = await import('@/lib/test-code-graph-mock');
  if (!codeGraphMockEnabled()) return;
  const { installSharedMockAgent } = await import('@/lib/test-mock-agent');
  const { installCodeGraphBoundaryMock } = await import('@/lib/test-code-graph-mock');
  installCodeGraphBoundaryMock(installSharedMockAgent());
  console.info('[worker] E2E_TEST_CODE_GRAPH active — index-writer seam mocked.');
}

/**
 * ⚠️ ERROR MONITORING, AND THE REASON IT IS HERE RATHER THAN INHERITED
 * (MOTIR-3606).
 *
 * `instrumentation.ts` is what initialises Sentry for the app — and it is a
 * NEXT.JS HOOK, so this process never runs it, exactly as its own header says of
 * the E2E seams two functions up. The consequence was not a missing convenience:
 * **every scheduled job in production ran in a process with no error monitoring
 * at all.** `system.daily-health-check` dead-lettered every morning for 23 days
 * and the only trace it left anywhere was a `job_run` row, which is a surface a
 * person has to decide to go and look at. That is half of why nobody found out.
 *
 * The options come from the same builder the Next server uses
 * (`serverSentryInitOptions()`), so the two Node runtimes cannot drift in what
 * they report or in what they refuse to send — and it returns null with no
 * `SENTRY_DSN`, which keeps the self-host contract: no init, no integrations, no
 * transport, phones nowhere.
 *
 * FIRST in `main()`, above the seams and the loop, so an exception thrown while
 * the worker is still starting is reported rather than lost.
 */
function initMonitoring(): void {
  const options = serverSentryInitOptions();
  if (!options) return;
  Sentry.init(options);
  console.info(`[worker] error monitoring on (environment: ${options.environment ?? 'unset'})`);
}

async function main(): Promise<void> {
  initMonitoring();

  // Before anything claims a run: a supervised job's first act is an external
  // call, so the seam has to be in place before the loop starts.
  await installE2ESeams();

  // The triggering event's payload lives on `job_event`; a cron run has no event
  // and gets an empty payload.
  const payloadFor = async (run: { eventId: string | null }): Promise<unknown> => {
    if (!run.eventId) return {};
    const event = await withSystemContext((tx) =>
      tx.jobEvent.findUnique({ where: { id: run.eventId! } }),
    );
    return event?.data ?? {};
  };

  // Armed BEFORE the worker starts, so an empty registry refuses at start-up
  // rather than after the first claim — `main`'s catch turns the throw into a
  // non-zero exit with the diagnosis, which is what makes the failure visible.
  const scheduler = new JobScheduler();
  scheduler.start();

  const worker = new JobWorker({
    async execute(run) {
      await executeWithLedger(run, await payloadFor(run));
    },
    // The scheduler rides the claim loop (MOTIR-3471) — one tick, at the top of
    // each poll, so a fire it enqueues is claimed by the same pass. It logs
    // through its own injected sink, so there is nothing to report here.
    onSchedulerTick: () => scheduler.tick().then(() => undefined),
    // The after-all-retries-exhausted hook — the engine's `onFailure`. See
    // `lib/jobs/engine/ledger.ts` for why it is not a catch inside `execute`.
    async onTerminalFailure(run, error) {
      await recordEngineTerminalFailure(run, error, await payloadFor(run));
    },
  });

  worker.start();
  console.info(`[worker] started as ${worker.workerId}`);

  const listener = await listenForQueuedJobs(() => worker.notify());

  let shuttingDown = false;
  const drain = (signal: string) => {
    // A second signal must not start a second drain: the release is idempotent
    // but a concurrent one would race the in-flight wait and cut it short.
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[worker] ${signal} — draining`);
    void (async () => {
      await listener.stop();
      await worker.shutdown();
      await db.$disconnect();
      console.info('[worker] drained; exiting');
      process.exit(0);
    })();
  };

  // SIGTERM is what Fly sends before a SIGKILL on every deploy — several times a
  // day. SIGINT is the local equivalent.
  process.on('SIGTERM', () => drain('SIGTERM'));
  process.on('SIGINT', () => drain('SIGINT'));

  // ⚠️ RELEASE ON AN UNCAUGHT CRASH TOO, best-effort. The lease already covers
  // this (an expired lease is reclaimed), but a lease takes a minute to expire
  // and a release is instant — so on the one crash path where we still have a
  // connection, hand the runs back rather than making the next claimant wait out
  // the lease.
  process.on('uncaughtException', (err) => {
    console.error('[worker] uncaught exception; releasing claims', err);
    void withSystemContext((tx) => jobQueueRepository.releaseClaims(worker.workerId, tx))
      .catch(() => {})
      .finally(() => process.exit(1));
  });
}

void main().catch((err: unknown) => {
  console.error('[worker] failed to start', err);
  process.exit(1);
});
