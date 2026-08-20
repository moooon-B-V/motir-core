import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// MOTIR-2442 — the DESIGN-ASSET GUARD lane.
//
// ── The hole this closes ────────────────────────────────────────────────────
// `ci.yml`'s Vitest, E2E, sandbox and runner-image jobs skip on a
// `design/*` branch, and rightly so: a diff that edits nothing but
// `design/**` has no app code for a browser suite or a Docker matrix to
// exercise. But two specs in `tests/**` read the design ASSETS rather than the
// app, so for them the skip landed exactly backwards — the only pull requests
// that can break them were the only ones that never ran them. MOTIR-2259
// merged green on `design/MOTIR-2259-roles-permissions`, `main` went red, and
// it surfaced hours later on an unrelated `subtask/*` PR that had not touched
// a design asset (MOTIR-2441).
//
// This config is the lane that fixes it: the design-asset guards, and only
// those, run on EVERY branch prefix from the `design-guards` job in `ci.yml`.
// The expensive things the prefix exists to save — the Playwright matrix, the
// DB-backed integration suites, the sandbox/runner image builds — stay skipped.
//
// ── Why a separate config rather than the root one ──────────────────────────
// `vitest.config.ts` carries a `globalSetup` that provisions one Postgres
// database per worker and a `setupFiles` chain that rebinds DATABASE_URL into
// it. Running ANY file under that config — even a spec that touches no
// database — therefore needs a migrated Postgres, which would make this lane
// as slow as the job it is meant to run beside. Nothing in `include` below
// touches a database, so this config drops both and the lane is an install
// plus a few seconds of Node.
//
// ── The `include` list is the enumeration, and it is guarded ────────────────
// `tests/ci-design-guards-lane.test.ts` re-derives the list by scanning
// `tests/**` for a path built into the `design/` tree and fails if a spec is
// missing from it. So a future design-asset guard cannot be written and
// silently left out of this lane — which is the same failure, one level up,
// as the one the lane exists to remove.
export default defineConfig({
  test: {
    environment: 'node',
    // Every spec that reads the `design/**` asset tree. Nothing else: this lane
    // runs on branches where the rest of the suite is deliberately skipped, so
    // an entry that needs a database or a browser would wedge it.
    // `reader-facing-noun` (MOTIR-2540) reads `design/**` for the opposite
    // reason to its neighbour: the design tree is EXCLUDED from its scan, and it
    // opens `design/settings/design-notes.md` to prove that exclusion is
    // load-bearing rather than vacuous. That still makes it a spec a design-only
    // PR can break, which is exactly what this lane exists to catch.
    include: [
      'tests/design-asset-addresses.test.ts',
      'tests/reader-facing-noun.test.ts',
      'tests/brand/waveBand.test.ts',
      // `design-assets-uploader` (MOTIR-2668) splits the REAL
      // `design/work-items/design-notes.md` into its `##` sections, because the
      // reason the published note is scoped to sections at all is a property of
      // that actual file. A design PR that restructures it can break this spec,
      // which is precisely what this lane is for.
      'tests/design-assets-uploader.test.ts',
      // `design-ink-contrast` (MOTIR-3014) is the ink-contrast guard pointed at
      // `design/**`. It is the spec this lane most obviously exists for: the
      // asset it rules on is only ever edited by a `design/*` PR, and the code
      // guard it extends (`tests/theme/inkContrastLint.test.ts`) is in the root
      // config, which such a PR skips.
      'tests/design-ink-contrast.test.ts',
      // `design-three-file-set` (MOTIR-3069) walks the tree for the rule
      // `CLAUDE.md` states and nothing measured: every `*.mock.html` has a
      // same-basename `.png`, and every area shipping an asset has a
      // `design-notes.md`. Seven mocks had shipped without an export, the
      // oldest for ten weeks — a design PR is both the only thing that can
      // break this and the only thing that can fix it, so it belongs here.
      'tests/design-three-file-set.test.ts',
      // `theme/orb-glyph-contrast` (MOTIR-3207) measures the floating orb's
      // white mark against its own gradient in all twenty palette x theme
      // contexts, and one of its assertions is that
      // `design/ai-chat/ai-callout-menu.mock.html` panel 9 reproduces the
      // shipped recipe by REFERENCE — it reads the same `--orb-lit-mix` token
      // instead of copying the number. A design PR editing that panel is
      // therefore the thing most likely to break it, and would otherwise skip
      // the root config that runs it.
      'tests/theme/orb-glyph-contrast.test.ts',
    ],
  },
  resolve: {
    // The root config gets `@/…` from `vite-tsconfig-paths` via the Next plugin
    // chain it inherits; this standalone config resolves the alias itself.
    // `waveBand.test.ts` imports `@/components/brand/waveBand`.
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
