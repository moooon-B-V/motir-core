// THE BOOT GUARD ON THE `memory` RATE-LIMIT STORE (Story MOTIR-8547 · MOTIR-8614).
//
// A production build that finds `MOTIR_RATE_LIMIT_STORE=memory` REFUSES TO
// START. Production runs more than one `app` machine (`fly.toml`
// `min_machines_running = 2`), and the `memory` store is a per-process `Map`, so
// one stray value turns every app-level limit — and, through
// `lib/rateLimit/betterAuthStorage.ts`, every Better-Auth limit — into
// `limit × machines` while every header still claims the limit holds.
//
// Refusing at boot, not logging: a logged error needs a second mechanism to read
// it and fail the deploy, and none exists. A machine that does not come up
// already fails Fly's health check, so the deploy fails on its own. And at boot,
// not at the first limited request, which may come minutes after a deploy went
// green.
//
// ⚠️ ITS OWN MODULE, WITH NO IMPORTS, ON PURPOSE. `instrumentation.ts` calls it
// at every server boot. `lib/rateLimit/store.ts` imports the Postgres store and
// through it `lib/db.ts`, which builds the Prisma pool AT IMPORT — so calling the
// guard from there would open a database pool in `register()` for a check that
// reads two env vars. `store.ts` re-exports it, so it is found where the store
// choice is made.
//
// `NODE_ENV === 'production'` is the trigger, deliberately wider than "more than
// one machine": a process cannot know its fleet size, and `NODE_ENV` is the one
// signal every deployment shares. The unset-and-no-`DATABASE_URL` default, which
// also resolves to `memory`, is out of the trigger: `lib/db.ts` throws
// `DATABASE_URL is not set` the first time any repository is imported, so such a
// process cannot serve a limited request anyway.

/** The env var that selects the rate-limit store backend. */
export const RATE_LIMIT_STORE_ENV = 'MOTIR_RATE_LIMIT_STORE';

/** Raised at boot when a production build is configured with the `memory` store. */
export class MemoryRateLimitStoreRefusedError extends Error {
  constructor(value: string) {
    super(
      `${RATE_LIMIT_STORE_ENV}="${value}" is refused in a production build: the memory store ` +
        'counts in one process, so on more than one machine every rate limit becomes ' +
        `limit × machines. Unset ${RATE_LIMIT_STORE_ENV} or set it to "postgres" — a ` +
        'single-instance self-host uses postgres too.',
    );
    this.name = 'MemoryRateLimitStoreRefusedError';
  }
}

/**
 * Throw {@link MemoryRateLimitStoreRefusedError} when `env` is a production build
 * explicitly configured with the `memory` store. Compares the value the way
 * `resolveRateLimitBackend()` does: trimmed and case-insensitive.
 */
export function assertRateLimitStoreAllowed(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (env['NODE_ENV'] !== 'production') return;
  const raw = env[RATE_LIMIT_STORE_ENV];
  if (raw?.trim().toLowerCase() === 'memory') throw new MemoryRateLimitStoreRefusedError(raw);
}
