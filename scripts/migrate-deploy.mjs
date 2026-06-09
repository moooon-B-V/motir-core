/**
 * scripts/migrate-deploy.mjs — `prisma migrate deploy` with a cold-start retry.
 *
 * Wired into the `build` script (package.json) in place of a bare
 * `prisma migrate deploy`. Migrations were folded into the Vercel build in
 * 8fc649d (1.1.5) so every deploy migrates its target Neon branch: production
 * Neon for prod, and the SHARED `preview` branch for every preview deploy.
 * (We dropped the per-PR Neon branch integration to stay under the free-tier
 * CU-hr budget — all preview deploys now point at one long-lived `preview`
 * branch via a static DATABASE_URL on Vercel's Preview environment. `migrate
 * deploy` is idempotent and takes a migration advisory lock, so concurrent
 * preview builds racing the same branch serialize safely rather than collide.)
 *
 * Why the retry: the shared `preview` branch (and prod) scale to zero when
 * idle, so the compute can be cold/suspended when a deploy reaches the migrate
 * step. Prisma's direct (unpooled) connection then fails with `P1001: Can't
 * reach database server` after its ~5s connect timeout — even though the
 * compute wakes a couple of seconds later. That cold start is transient, so we
 * retry on P1001 (and P1001 only) with a short linear backoff.
 *
 * What we DON'T retry: every other failure — a genuine migration error, a
 * drifted/failed migration (P3009), a syntax error in SQL — fails immediately.
 * Masking those behind retries would turn a clear red build into a slow,
 * confusing one. In CI and prod the database is always reachable, so this
 * script runs `migrate deploy` exactly once and exits, same as before.
 *
 * (Only console.warn / console.error are used below — both allowed by the
 * project's no-console rule, since stdout/stderr IS a build step's surface.)
 */
import { spawnSync } from 'node:child_process';

const MAX_ATTEMPTS = 5;
// P1001 = "Can't reach database server" — the ONLY error class we treat as a
// transient cold start. Anything else is a real failure and must not be hidden.
const RETRYABLE = /P1001/;

// Synchronous sleep (no async/top-level-await needed for a linear build step).
// Atomics.wait blocks the thread for `ms` without busy-spinning the CPU.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  // shell:true so PATH / pnpm's node_modules/.bin shim resolve `prisma`
  // exactly as the original `&& prisma migrate deploy &&` build chain did.
  const result = spawnSync('prisma migrate deploy', {
    shell: true,
    encoding: 'utf8',
  });

  // Stream the child's output through unchanged so the build log reads the
  // same as a bare invocation on the happy path.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    // The spawn itself failed (e.g. `prisma` not on PATH) — not a DB issue.
    console.error(`migrate-deploy: failed to launch prisma: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status === 0) {
    process.exit(0);
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const isColdStart = RETRYABLE.test(output);

  if (!isColdStart || attempt === MAX_ATTEMPTS) {
    console.error(
      isColdStart
        ? `migrate-deploy: database still unreachable (P1001) after ${MAX_ATTEMPTS} attempts — giving up.`
        : `migrate-deploy: prisma migrate deploy failed (exit ${result.status}); non-retryable, not a cold start.`,
    );
    process.exit(result.status ?? 1);
  }

  const delaySeconds = 3 * attempt; // 3s, 6s, 9s, 12s
  console.warn(
    `migrate-deploy: P1001 on attempt ${attempt}/${MAX_ATTEMPTS} — Neon compute likely cold; ` +
      `retrying in ${delaySeconds}s.`,
  );
  sleep(delaySeconds * 1000);
}
