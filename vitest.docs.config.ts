import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DOCS_GUARD_SPECS } from './tests/helpers/docsGuardLane';

// MOTIR-4408 — the DOCS-GUARD lane.
//
// ── The hole this closes ────────────────────────────────────────────────────
// `ci.yml`'s `changes` job classifies a pull request touching only `docs/**` as
// `app=false`, and the sharded Vitest job, the coverage merge and the E2E legs
// are all gated on that boolean. The classification is CORRECT and this lane
// does not touch it. But EIGHT specs in `tests/**` read a `docs/**` file as
// their SUBJECT, and for those the skip lands exactly backwards: the only pull
// requests that can break them are the only ones that never run them. Delete a
// row from `docs/styles/3d-immersive.md` §4b or from
// `docs/decisions/permission-inventory.md` and `CI complete` passes green
// having executed none of the guards written to catch that edit.
//
// Seven of the eight are the `include` below. The eighth,
// `tests/reader-facing-noun.test.ts`, is already carried by
// `vitest.design.config.ts` — also unconditional — so it needs nothing from
// here, and `tests/ci-docs-guards-lane.test.ts` enforces membership of ANY
// unconditional lane rather than of this one.
//
// This config is the lane that fixes it: the docs-reading guards, and only
// those, run from the `docs-guards` job in `ci.yml` on every diff shape. The
// expensive things `app=false` exists to save — twelve Vitest legs, the coverage
// merge, the Playwright matrix, the image builds — stay skipped.
//
// It is the same remedy as `vitest.design.config.ts` (MOTIR-2442) one diff class
// over, and deliberately so: that lane is the shape that worked, and this is the
// third instance of the mechanism it was the first fix for.
//
// ── Why a separate config rather than the root one ──────────────────────────
// `vitest.config.ts` carries a `globalSetup` that provisions one Postgres
// database per worker and a `setupFiles` chain that rebinds `DATABASE_URL` into
// it, so running ANY file under it needs a migrated Postgres — which would make
// this lane as slow as the job it exists to run beside. Nothing here opens a
// database, so this config drops both and the lane is an install, a client
// generation and about three seconds of Node.
//
// ── `env.DATABASE_URL`, and why a lane with no database sets one ────────────
// `catch-up-disposition-adr.test.ts` holds ADR §11.4 against the job registry,
// and `import '@/lib/jobs/registry'` reaches `@/lib/db`, which constructs a
// PrismaClient AT MODULE SCOPE and throws when `DATABASE_URL` is unset. Nothing
// CONNECTS — `new PrismaPg({ connectionString })` is lazy — so the lane needs a
// parseable string, not a server.
//
// The value points at a port nothing listens on, on purpose: any spec that
// actually issues a query fails to connect, loudly, at the first statement. That
// is the property wanted from a lane that promises no database — a spec which
// needs one cannot pass here quietly. Set in the CONFIG rather than in the CI
// job so the lane behaves identically locally, including on a box that has a
// real `DATABASE_URL` exported.
export default defineConfig({
  test: {
    environment: 'node',
    // Derived membership, not an enumeration: the list lives in
    // `tests/helpers/docsGuardLane.ts` and `tests/ci-docs-guards-lane.test.ts`
    // re-derives the population from the tree and fails when the two disagree.
    // The NEXT docs-reading guard written names itself there rather
    // than shipping unwatched — which is the same failure, one level up, as the
    // one this lane exists to remove.
    include: [...DOCS_GUARD_SPECS],
    env: {
      DATABASE_URL: 'postgresql://docs-lane@127.0.0.1:1/unused',
    },
  },
  resolve: {
    // The root config gets `@/…` from `vite-tsconfig-paths` via the Next plugin
    // chain it inherits; this standalone config resolves the alias itself, the
    // same way `vitest.design.config.ts` does.
    alias: {
      '@': resolve(fileURLToPath(new URL('.', import.meta.url))),
      // Same stub the root config uses: `import 'server-only'` is a Next
      // build-time marker with no plain-node resolution.
      'server-only': resolve(
        fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
      ),
    },
  },
});
