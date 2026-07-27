// Component-test effect-ordering AUDIT instrument (MOTIR-1737).
//
// WHY THIS EXISTS
// ---------------
// `vitest.config.ts` never sets `IS_REACT_ACT_ENVIRONMENT`, and React Testing
// Library's async wrapper deliberately turns the act environment OFF for
// `findBy*` / `waitFor`, draining the microtask queue with a bare
// `setTimeout(0)`. React, however, flushes PASSIVE effects on a *separate*
// scheduler callback — `setImmediate` under Node. So in EVERY component test an
// awaited `findBy*` can resolve while passive effects are still pending: the
// render landed, the effect did not. Any NON-retrying assertion that depends on
// an effect (`getBy*`, `expect(mock).toHaveBeenCalled()`, a `querySelector`) is
// then a load-dependent flake — it passes on a quiet laptop and fails under CI
// contention. MOTIR-1736 (`ProjectRoadmapCanvas`) was one instance; nothing
// structurally confines the shape to that file.
//
// WHAT IT DOES
// ------------
// It pushes React's passive-effect flush BEHIND the `setTimeout(0)` that RTL
// drains on, which makes the latent ordering race DETERMINISTIC. Crucially it
// adds NO delay — the shim only re-orders two already-queued callbacks — so it
// cannot manufacture false "too slow" failures the way a delay-based variant
// does (an earlier 8 ms form flagged `sprint-points-refetch` and
// `delete-work-item-dialog`, both of which pass at zero delay; they were slowed
// past the 1 s `findBy` budget, not racing).
//
// A test that fails under this shim has a REAL ordering bug: fix it by awaiting
// the authoritative signal (`findBy*` / a retrying `waitFor`), or by flushing
// with `await act(async () => {})` before a negative assertion — see
// `CLAUDE.md` § "E2E tests wait on the AUTHORITATIVE signal", component-test
// bullet. Do NOT "fix" it by adding a sleep.
//
// KNOWN INSTRUMENT ARTIFACT (do not chase)
// ----------------------------------------
// A test file using `vi.useFakeTimers()` replaces `setTimeout`, so the shim's
// deferral never fires and the file times out. `tests/components/appearance-sync.test.tsx`
// is the known case; it is excluded via `vitest.late-effects.config.ts`.
//
// Wired ONLY by `vitest.late-effects.config.ts` (the nightly audit lane) — it
// is never loaded by the default `vitest.config.ts`, so PR CI is untouched.

const realSetImmediate = globalThis.setImmediate;

globalThis.setImmediate = ((
  fn: (...args: unknown[]) => void,
  ...args: unknown[]
): ReturnType<typeof setImmediate> =>
  realSetImmediate(() => {
    setTimeout(() => fn(...args), 0);
  })) as typeof globalThis.setImmediate;
