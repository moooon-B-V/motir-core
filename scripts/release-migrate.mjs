/**
 * scripts/release-migrate.mjs — the entrypoint for `fly.toml`'s `release_command`.
 *
 * Fly runs the release command in a temporary machine built from the SAME image
 * as the app, before any new machine takes traffic. That image is the
 * `output: 'standalone'` runner, and the standalone bundle does NOT contain the
 * Prisma CLI — Next traces what SERVES requests, and the CLI serves none. So the
 * Dockerfile stages the whole migration lane into ONE self-contained directory,
 * `/app/migrate`, holding its own flat `node_modules` plus `prisma.config.ts`,
 * `prisma/` and this script. The Dockerfile records why that tree cannot simply
 * be the repo's pnpm one.
 *
 * Self-contained is the load-bearing word, and it is why this script chdirs to
 * its own directory rather than to the application root. `prisma migrate deploy`
 * resolves every input from the working directory — `prisma.config.ts`, and
 * through it `prisma/schema.prisma` and `prisma/migrations`. That config is not
 * bookkeeping: it is where the datasource URL comes from, because
 * `schema.prisma`'s `datasource db` block deliberately carries NO `url`. And the
 * config is a MODULE — it imports `dotenv` and `prisma/config`, which Node
 * resolves from the config file's own location. Run it from `/app` and those
 * imports look in the standalone server's minimal `node_modules`, which has
 * neither, and the deploy dies with `Cannot find module 'dotenv'`. Keeping the
 * config beside the toolchain that satisfies it removes the failure mode instead
 * of documenting it.
 *
 * The two steps below are therefore:
 *   1. `chdir` here, so config discovery and its imports both land in this
 *      directory.
 *   2. Put this directory's `.bin` on PATH, because `migrate-deploy.mjs` spawns
 *      `prisma migrate deploy` through a shell and resolves the binary from PATH
 *      — exactly as it does in the build lane. Both paths derive from this
 *      file's own location, so nothing depends on how Fly invokes it.
 *
 * Why reuse `migrate-deploy.mjs` rather than call the CLI directly: the database
 * is Neon, whose compute suspends when idle, and a direct (unpooled) connection
 * to a cold compute fails with `P1001` a second or two before it would have
 * succeeded. The build lane already learned that and retries P1001 — and only
 * P1001 — five times. A release command has no retry of its own, and a non-zero
 * exit rolls the whole deploy back, so this is the lane that needs the wrapper
 * most.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

process.chdir(here);
process.env['PATH'] = `${join(here, 'node_modules', '.bin')}:${process.env['PATH'] ?? ''}`;

// The retry wrapper runs its loop at module scope rather than exporting a
// function, so this import IS the invocation. Awaited so an import-time failure
// surfaces as a rejected top-level await (a non-zero exit) instead of an
// unhandled rejection Fly might not read as failure.
await import('./migrate-deploy.mjs');
