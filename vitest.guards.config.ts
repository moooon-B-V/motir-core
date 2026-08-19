import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { STRUCTURAL_GUARD_SPECS } from './tests/helpers/structuralGuardLane';

// MOTIR-3144 — the STRUCTURAL GUARD lane.
//
// ── What these files are ────────────────────────────────────────────────────
// Every spec below parses the source tree — `lib/` and `app/`, ~1 650 files —
// through the TypeScript compiler API and asserts something structural about
// it: that no service arrives unbound, that a bare `$transaction` cannot
// enclose a policy-gated statement, that a second rate-limit counter cannot
// appear. They read the repository as DATA. None of them opens a database,
// starts a server, or renders a component.
//
// They are lint wearing a test's clothes, and until this card they ran inside
// the sharded, database-backed, coverage-instrumented Vitest job — which is
// the most hostile environment in the repository for exactly this workload.
//
// ── The measurement that moved them ─────────────────────────────────────────
// `tests/rls/bare-transaction-guard.test.ts` on PR #2145:
//
//   alone, on a quiet 14-core box            8.10 s
//   under local full-suite contention       41.2  s
//   CI `Vitest (2/3)`                     > 120    s  — twice, same hook
//
// `Error: Hook timed out in 120000ms`, zero assertion failures, on a branch
// whose diff did not grow the scan by a single file (1 658 on both sides). Eight
// seconds of work losing a 120-second budget is a contention multiplier above
// 14x, and no budget derived from a quiet-box measurement survives that. Three
// previous cards raised a budget or made a scan faster; each fixed one guard and
// left the next one to rediscover the same environment (MOTIR-2815,
// MOTIR-3067, and the third instance on this card).
//
// ── Why a separate config rather than the root one ──────────────────────────
// Same reasoning as `vitest.design.config.ts`, which this lane deliberately
// mirrors. `vitest.config.ts` carries a `globalSetup` that provisions one
// Postgres database per worker and a `setupFiles` chain that rebinds
// DATABASE_URL into it, so running ANY file under it needs a migrated Postgres.
// Nothing in `include` below opens a database — verified, not assumed: none of
// these files imports `@/lib/db`, `../helpers/adminDb`, or a fixture.
//
// This lane also runs WITHOUT `--coverage`, and that is not incidental. The
// sharded job is `vitest run --config vitest.collect.config.ts --shard=… --coverage`
// (`ci.yml`), so every one of these scans was being v8-instrumented while it
// parsed the tree — the precise mechanism of MOTIR-2815, the first instance of
// this class.
//
// ── What leaving the coverage run costs: NOTHING, and that is checked ───────
// Not one file in the lane imports from `lib/`, `app/` or `components/`, so
// none of them can carry coverage out of the merged report. That is now true by
// construction rather than by luck: `storeDeadline` DID reach `@/lib/db`, via a
// single constant imported from `tests/helpers/rateLimitStore.ts`, which pulls
// in `postgresStore` → `rateLimitService` → the Prisma client. It threw
// `DATABASE_URL is not set` at import time the first time this lane ran — a
// filesystem scanner that could not start without Postgres, to read `10_000`.
// The constant now lives alone in `tests/helpers/rateLimitStoreDeadline.ts`.
//
// So the coverage question that sinks this kind of change (a flake fix that
// quietly drops a gated file below its floor — `flake-fix-drops-coverage`) has
// an empty answer here, and the membership test keeps it empty.
//
// ── The `include` list is the enumeration, and it is guarded ────────────────
// `tests/ci-structural-guards-lane.test.ts` re-derives this list by scanning
// `tests/**` for whole-tree scanners and fails if one is missing from it — so a
// guard written later cannot be quietly left behind in the sharded run, which
// is this same bug one level up.

export default defineConfig({
  test: {
    environment: 'node',
    include: [...STRUCTURAL_GUARD_SPECS],
    // These are whole-tree parses, not database calls, so the root config's
    // 15 s `testTimeout` never described them. A budget is only honest once the
    // work is out of contention and its cost is bounded — which is what this
    // lane buys. Sized at roughly 7x the measured cost of the slowest guard on a
    // quiet box, to cover a loaded shared runner without hiding a real hang.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One worker. The scans are CPU-bound and each one already memoises per
    // root, so running them in parallel buys nothing and reintroduces exactly
    // the contention this lane exists to remove.
    fileParallelism: false,
  },
  resolve: {
    // The root config gets `@/…` from `vite-tsconfig-paths` via the Next plugin
    // chain it inherits; this standalone config resolves the alias itself, the
    // same way `vitest.design.config.ts` does. `storeDeadline` needs it: its one
    // import reaches `tests/helpers/rateLimitStore.ts`, which is written in
    // `@/…` form.
    alias: {
      '@': resolve(fileURLToPath(new URL('.', import.meta.url))),
      // `import 'server-only'` is a Next build-time marker with no plain-node
      // resolution — same stub the root and design configs use.
      'server-only': resolve(
        fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
      ),
    },
  },
});
