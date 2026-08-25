import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// The Postgres job engine's WORKER, running inside the E2E lane
// (Story MOTIR-3414 · Subtask MOTIR-3427).
//
// ⚠️ WHY THIS IS NOT A `webServer` ENTRY, which is where a reader will look for
// it first. Playwright's `webServer` polls a `url` or a `port` for readiness, and
// the worker binds neither — it is a claim loop, not a server. So it is started
// from `globalSetup` (which runs after the webServers are up and before the first
// spec) and stopped from `globalTeardown`.
//
// ⚠️ AND IT IS A THIRD PROCESS IN THE LANE ON PURPOSE. MOTIR-3427's original text
// asked for "no bespoke server configuration", which could not hold: the engine
// runs in its OWN process group by design (MOTIR-3421 — job load must not contend
// with request serving), so a run queued onto it has nothing to claim it unless
// the lane starts one. The card was amended to say so. This is the exact analogue
// of the `inngest-cli dev` entry already in the lane: the OLD engine needed its
// executor there too.
//
// It runs the BUNDLE — the same `.worker/worker.mjs` artifact the Dockerfile
// stages at `/app/worker/` — rather than the TypeScript source, so the lane
// exercises what production actually runs. A source-run would prove the code and
// not the packaging, and the packaging is where `argon2`'s native binding and the
// standalone tree's module resolution live.

const WORKER_BUNDLE = path.resolve('.worker/worker.mjs');

let worker: ChildProcess | undefined;

/** True when the E2E lane should run a worker at all. */
export function jobWorkerEnabled(): boolean {
  return process.env['E2E_JOB_WORKER'] === '1';
}

/**
 * Start the worker and wait until it has announced itself.
 *
 * Resolves on the worker's own startup line rather than after a sleep — the
 * authoritative signal, the same discipline every spec in this lane owes its
 * assertions.
 */
export async function startJobWorker(): Promise<void> {
  if (!jobWorkerEnabled() || worker) return;

  if (!existsSync(WORKER_BUNDLE)) {
    throw new Error(
      `[e2e-job-worker] ${WORKER_BUNDLE} is missing. The lane runs the SHIPPED bundle, not the ` +
        `TypeScript source, so it must be built first: \`pnpm build:worker\`. ` +
        `(playwright.config.ts's app webServer command builds it; if you are running the spec ` +
        `against an already-running server, build it by hand.)`,
    );
  }

  const child = spawn(process.execPath, [WORKER_BUNDLE], {
    env: {
      ...process.env,
      // The worker is a background process; nothing about it is a request path.
      NODE_ENV: process.env['NODE_ENV'] ?? 'production',
      // ⚠️ THE WORKER NEEDS THE SAME HARNESS FLAG THE APP webServer GETS, and
      // omitting it is not a subtle failure — it is an immediate refusal to boot.
      // The worker runs the app's own modules, so `NODE_ENV=production` (correct
      // for it: it runs the shipped bundle) trips every guard written for a real
      // deployment. The first one it hits is `lib/email.ts`'s:
      //
      //   Error: Email provider 'file' is not allowed in production.
      //
      // …because the pilot job SENDS EMAIL, through the test sink. This flag is
      // exactly what re-relaxes those seams for a production-mode test process,
      // and the worker is one. Found by running the spec, not by reading it.
      E2E_PROD_HARNESS: '1',
      // ⚠️ AND THE EMAIL SINK, FOR THE SAME REASON ONE FLAG OVER (Bug MOTIR-3498).
      // `playwright.config.ts` sets `EMAIL_PROVIDER: 'file'` on the **webServer
      // only**. This is a THIRD process and inherits the RUNNER's env, which
      // carries `EMAIL_OUTBOX_PATH` (set at config load) but not the provider —
      // so every job the engine runs sent its mail through the dev-CONSOLE
      // provider and the outbox never saw it. The failure is maximally quiet: the
      // send succeeds, the ledger row reaches `succeeded`, the message is printed
      // to this process's stdout, and `waitForEmail` times out having seen zero.
      //
      // Any webServer-only variable a JOB HANDLER reads has to be mirrored here.
      // The worker runs the same app modules; it just is not the app server.
      EMAIL_PROVIDER: 'file',
      ...(process.env['EMAIL_OUTBOX_PATH']
        ? { EMAIL_OUTBOX_PATH: process.env['EMAIL_OUTBOX_PATH'] }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker = child;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('[e2e-job-worker] the worker did not announce itself within 30s'));
    }, 30_000);

    const onLine = (buf: Buffer) => {
      const text = buf.toString();
      // Surface the worker's output into the runner's log: a spec that hangs
      // waiting for a run needs to see whether the worker claimed it, and a
      // silent child process is the worst thing to debug against.
      process.stderr.write(`[e2e-job-worker] ${text}`);
      if (text.includes('[worker] started as')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`[e2e-job-worker] exited before starting (code ${code})`));
    });
  });
}

/**
 * Stop the worker, letting it DRAIN.
 *
 * `SIGTERM` rather than `SIGKILL` deliberately: draining is a behaviour the
 * worker ships (MOTIR-3421), and using the graceful path here means the lane
 * exercises it on every run rather than only in the unit test that asserts it.
 */
export async function stopJobWorker(): Promise<void> {
  const child = worker;
  if (!child) return;
  worker = undefined;

  await new Promise<void>((resolve) => {
    const done = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 15_000);
    child.on('exit', () => {
      clearTimeout(done);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
