// Turns React's ACT ENVIRONMENT on for the browser-environment (happy-dom)
// test files — the ROOT fix for the component-test effect-ordering race class
// (MOTIR-1738, the option (b) deferred by MOTIR-1737).
//
// WHY THIS EXISTS
// ---------------
// React Testing Library's async wrapper (`findBy*` / `waitFor`) deliberately
// turns the act environment OFF while it polls, draining the microtask queue
// with a bare `setTimeout(0)`. React flushes PASSIVE effects on a *separate*
// scheduler callback (`setImmediate` under Node), so with no act environment an
// awaited `findBy*` can resolve while passive effects are still pending: the
// render landed, the effect did not. Any NON-retrying assertion downstream of an
// effect (`getBy*`, `expect(mock).toHaveBeenCalled()`, a `querySelector`) is
// then a load-dependent flake — green on a quiet laptop, red under CI
// contention. MOTIR-1736 (`ProjectRoadmapCanvas`) and the two files fixed in
// MOTIR-1737 (`OnboardingCanvasRoadmap`, `TierDocModal`) were three instances;
// nothing structurally confined the shape to them.
//
// With `IS_REACT_ACT_ENVIRONMENT = true`, React flushes passive effects
// SYNCHRONOUSLY at the end of every `act()` scope — and RTL wraps `render` and
// every `fireEvent` / `userEvent` in one. The race cannot form: by the time an
// assertion runs, the effects that the render queued have already run. That
// removes the class rather than detecting it, which is why this replaces the
// nightly `component-effect-audit` lane rather than joining it.
//
// WHY IT SELF-SCOPES
// ------------------
// `vitest.config.ts` runs `environment: 'node'` globally; the component files
// opt into happy-dom per-file via a `// @vitest-environment happy-dom`
// directive. A setupFile runs for EVERY test file, so this guards on `window`:
// the Node integration files (which never render React) are left untouched, and
// the flag is set only where a React renderer can observe it.
//
// THE CONTRACT IT IMPOSES
// -----------------------
// Any state update that lands OUTSIDE an RTL-owned act scope — a promise
// resolving after the awaited assertion, a timer callback, an event fired from
// outside `fireEvent` — now logs a "not wrapped in act(...)" warning. That
// warning is a REAL finding: it means the test asserted against a render the
// component had not finished. Fix it by awaiting the authoritative signal
// (`findBy*` / a retrying `waitFor`), or by flushing with
// `await act(async () => {})` before a negative assertion — never with a sleep.
// See `CLAUDE.md` § "E2E tests wait on the AUTHORITATIVE signal".

declare global {
  // React reads this off the global object; nothing in @types/react declares
  // it, so the flag needs its own ambient declaration to typecheck.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

if (typeof window !== 'undefined') {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

export {};
