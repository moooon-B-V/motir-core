/**
 * The WORKER ENTRYPOINT (Story MOTIR-3414 · Subtask MOTIR-3421).
 *
 * What `fly.toml`'s `worker` process group runs. It does four things and nothing
 * else: import the registry, start the loop, wire the signals, and stay up.
 *
 * ⚠️ THE REGISTRY IMPORT IS LOAD-BEARING AND LOOKS UNUSED. `lib/jobs/engine/registry.ts`
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
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { listenForQueuedJobs } from '@/lib/jobs/engine/notify';
// Side-effect import: evaluates all 24 definition modules so `defineJob` has
// registered every job. See the warning above — this is not an unused import.
import '@/lib/jobs/registry';

async function main(): Promise<void> {
  // The triggering event's payload lives on `job_event`; a cron run has no event
  // and gets an empty payload, mirroring what a scheduled Inngest run hands a
  // handler today.
  const payloadFor = async (run: { eventId: string | null }): Promise<unknown> => {
    if (!run.eventId) return {};
    const event = await withSystemContext((tx) =>
      tx.jobEvent.findUnique({ where: { id: run.eventId! } }),
    );
    return event?.data ?? {};
  };

  const worker = new JobWorker({
    async execute(run) {
      await executeWithLedger(run, await payloadFor(run));
    },
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
