// MOTIR-3144 — the structural-guard lane's MEMBERSHIP, in one module.
//
// It lives here rather than in `vitest.guards.config.ts` because it has THREE
// readers that must never disagree: that config's `include`, the root
// `vitest.config.ts`'s `exclude`, and `tests/ci-structural-guards-lane.test.ts`,
// which re-derives the candidates from the tree and fails if this list has
// drifted from them. (Exporting it from the config itself also made that config
// mix named and default exports, which Rollup warns about on every run.)

/**
 * The lane's membership, exported because it has TWO readers that must never
 * disagree: this config's `include`, and `vitest.config.ts`'s `exclude` — the
 * root run has to drop exactly what this one picks up. A guard listed in one
 * and not the other either runs twice (in the contended job this card exists to
 * leave) or not at all, and both failures are silent.
 *
 * ⚠️ This differs from `vitest.design.config.ts` in the one way that matters.
 * That lane ADDS a run: its specs stay in the root config too, because its
 * purpose is to reach branch prefixes the root job skips. This lane MOVES the
 * run — the whole point is that these files stop executing inside the sharded
 * database job — so the root config excludes every entry below.
 */
export const STRUCTURAL_GUARD_SPECS = [
  // ── tests/rls/ — the binding, transaction and singleton guards ─────────────
  'tests/rls/call-site-guard.test.ts',
  'tests/rls/bare-transaction-guard.test.ts',
  'tests/rls/ratchet-staleness-guard.test.ts',
  'tests/rls/singleton-read-guard.test.ts',
  'tests/rls/test-call-site-guard.test.ts',
  'tests/rls/test-singleton-statement-guard.test.ts',
  // ── tests/rateLimit/ — the one-counter and store-deadline guards ───────────
  // ⚠️ `storeDeadline` had to be UNPICKED before it could come here, and the
  // detail is worth keeping because a grep says the opposite twice over. Its
  // file body is full of `@/lib/rateLimit/store` strings that are FIXTURES in
  // template literals — source it feeds to its own scanner — so a grep for
  // imports finds matches that are not imports. But its one REAL import,
  // `TEST_RATE_LIMIT_STORE_TIMEOUT_MS` from `tests/helpers/rateLimitStore.ts`,
  // reached `@/lib/db` transitively and threw `DATABASE_URL is not set` at
  // import time — a filesystem scanner that could not run without Postgres,
  // purely to read `10_000`. The constant now lives alone in
  // `tests/helpers/rateLimitStoreDeadline.ts`, which imports nothing.
  'tests/rateLimit/one-counter-guard.test.ts',
  'tests/rateLimit/storeDeadline.test.ts',
  // ── tests/theme/ — the ink-contrast lint, found by the predicate ───────────
  // NOT on the card's list of ten, and that is the point of deriving membership
  // mechanically instead of copying an enumeration: `inkContrastLint` walks
  // `app/` + `components/` + `lib/` through the same shared scanner shape and
  // has exactly the same cost profile. `inkContrastScan` comes with it — it
  // exercises that scanner against a fixture tree, so it is the test that would
  // catch a memoisation cache keyed on nothing handing the fixture the real
  // repository's answer (the vacuous-pass trap MOTIR-2815 hit).
  'tests/theme/inkContrastLint.test.ts',
  'tests/theme/inkContrastScan.test.ts',
  // ── tests/theme/ — the shell viewport-unit guard (MOTIR-3208) ─────────────
  // Same shape again: a text walk of `app/` + `components/` + the design
  // system's `src/`, plus two stylesheets, asserting that every viewport-sized
  // length on the shell path is written in `dvh`. It opens no database, renders
  // nothing, and imports nothing from `lib/` or `app/`, so it carries no
  // coverage out of the merged report.
  'tests/theme/shellViewportUnits.test.ts',
  // ── tests/legal/ — the subprocessor-list guard (MOTIR-3631) ───────────────
  // Same shape once more: a text walk of `lib/` + `app/` for outbound hosts,
  // read against `content/legal/subprocessors.md` and `package.json`. It opens
  // no database, renders nothing, and imports nothing from `lib/` or `app/`, so
  // it carries no coverage into the merged report — but it reads ~1 650 files,
  // which is precisely the profile this lane exists to keep out of the sharded
  // database job.
  'tests/legal/subprocessor-list-guard.test.ts',
] as const;

/**
 * Whole-tree guards that must STAY in the sharded run, with the reason each one
 * cannot move. Named rather than omitted: the lane's membership test derives its
 * candidates mechanically, so a guard that is absent for a real reason has to
 * say so, and a guard that is absent by accident fails the test.
 */
export const DATABASE_BOUND_GUARDS: Readonly<Record<string, string>> = {
  'tests/rls/system-context-arm-guard.test.ts':
    'imports ../helpers/adminDb — it pairs the static scan with live assertions ' +
    'about the system context, so it needs a migrated database.',
  'tests/rls/org-context-arm-guard.test.ts':
    'imports ../helpers/adminDb — same shape as its system-context sibling one ' +
    'axis over (MOTIR-2959). The arm inventory it adjudicates against is a ' +
    'pg_policies read, not a source scan, so the lane cannot host it.',
  'tests/rls/other-context-arm-guard.test.ts':
    'imports ../helpers/adminDb — the workspace / user / org-user descriptors, ' +
    'adjudicated against the same live pg_policies inventory (MOTIR-2959).',
  'tests/permissions/roleAssignment.test.ts':
    'imports @/lib/db and ../helpers/adminDb — it checks the role-assignment ' +
    'matrix against real rows, not only against source.',
};
