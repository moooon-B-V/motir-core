/**
 * Fixed-window alignment for the `/api/v1` rate-limit tests.
 *
 * ── Why any of this is needed ────────────────────────────────────────────────
 * `consumeRateLimit` (`lib/api/v1/rateLimit.ts`) buckets on a grid aligned to
 * the EPOCH:
 *
 *     const windowStart = Math.floor(now / windowMs) * windowMs;
 *
 * The window therefore does **not** open at the first request — it opens
 * whenever the wall clock crosses a multiple of `windowMs`. A test that fires
 * several requests and asserts on their ACCUMULATED count is correct only if no
 * grid boundary falls between them; when one does, the counter resets mid-test
 * and the request expected to be refused is served instead.
 *
 * The odds are roughly `elapsed / windowMs`, and `elapsed` is milliseconds even
 * when nothing is wrong — each call runs the real route handler against real
 * Postgres. So the failure needs unlucky PHASE, not a slow runner: it is
 * invisible locally, it clears on `rerun --failed` every single time, and it
 * gets mis-diagnosed as "CI was loaded". **Widening the window only lowers the
 * probability; it never removes the class.** Aligning does.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Any test that sets a budget and then issues MORE THAN ONE request whose
 * outcome depends on the accumulated count must `await waitForWindowBoundary()`
 * first — after its fixture setup, immediately before the first counted
 * request, so the assertion owns a whole window instead of whatever was left of
 * a randomly-phased one. A test that issues a single counted request, or that
 * only reads `rateLimitBudget()` config, needs nothing.
 *
 * ── ⚠️ Do not copy this expression ──────────────────────────────────────────
 * MOTIR-2101 fixed this class in `rate-limit.test.ts` and the sweep stopped at
 * that file, so it kept firing from `story-gate.test.ts` (MOTIR-2224) — the
 * same defect, re-diagnosed from scratch, paid for twice. This module is the
 * ONE definition; import it rather than re-deriving the arithmetic. A guard
 * test (`tests/api/v1/rate-limit-window-alignment.guard.test.ts`) fails if a
 * second copy appears anywhere under `tests/`.
 */

/** Sleep for `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The window an accumulating test should budget against, paired with
 * `waitForWindowBoundary`.
 *
 * It is NOT the shipped 60 s default, for one reason: aligning costs up to a
 * whole window, so a test that aligned against 60 s would sleep ~30 s on
 * average. Nothing in these tests asserts the window's LENGTH — only the
 * accumulated count and the headers — so the window is free to be small enough
 * that the wait is affordable, and the alignment is what removes the race.
 *
 * Sized from measurement (MOTIR-2224, 2026-08-05): the heaviest counted section
 * in these suites is the 12-way concurrent batch at **19 ms** worst-of-20
 * (`p50` 5 ms); the 10×401-then-3 loop is 10 ms and the reported trio is 11 ms.
 * 2 s is a ~105× margin over the worst of those. That changes the failure mode
 * qualitatively rather than just making it rarer: the old one needed unlucky
 * PHASE (probability ≈ elapsed/window — which is why it fired every few days
 * across unrelated PRs), the remaining one would need a runner 105× slower than
 * measured, which is a broken machine and deserves to be a red test.
 */
export const ALIGNED_WINDOW_MS = 2_000;

/**
 * How far PAST the boundary to land. `setTimeout` may fire a hair early on a
 * coarse timer, and `Date.now()` is only millisecond-precise, so a wait that
 * aimed exactly at the boundary could still land in the outgoing cell — which
 * would leave the test with ~0 ms of window, the worst case of the very thing
 * this helper exists to prevent.
 */
export const BOUNDARY_OVERSHOOT_MS = 5;

/**
 * How much of `ALIGNED_WINDOW_MS` an in-process accumulating case must be handed
 * before it starts — the argument to `waitForWindowHeadroom`.
 *
 * ── Why headroom and not a full alignment, measured (MOTIR-2648) ─────────────
 * "Aligning costs half a window on average" is true of ONE call and false of a
 * suite, because the cost is not independent between cases. A case that aligns
 * lands just past a boundary and then finishes in ~20 ms, so the NEXT case
 * starts ~20 ms into a fresh cell and has to wait ~1 980 ms for the following
 * one. Serialised cases therefore pay close to the WHOLE window each, not half.
 *
 * Measured 2026-08-11 over `surfaceGuards` + `api-coding-convention-route` +
 * this guard's own suite (26 accumulating cases, 25 of them in `surfaceGuards`):
 * **15.9 s → 52.4 s**, i.e. **+36.5 s**, or ~1.4 s per case rather than the
 * ~0.7 s an independent-phase estimate predicts. MOTIR-2648 had budgeted ~37 s
 * for aligning all 37 sites unconditionally; aligning just the 26 that need it
 * cost the same, because the phases are not independent.
 *
 * Taking 500 ms of headroom instead lets consecutive cases SHARE one cell and
 * sleep only when it is nearly spent: ~1.5 s of usable window at ~20 ms a case
 * is many cases per sleep. Same three files, same 26 cases: **14.8 s**, and
 * `surfaceGuards` alone went 4.30 s → 4.39 s (mean of 3) — inside the noise.
 *
 * The guarantee is a stated floor rather than a probability: every case gets
 * ≥500 ms for ~19 ms of work (the worst-of-20 measured above), a ~26× margin,
 * held to the same "exceeding it means a broken machine, not bad luck" standard
 * as `ALIGNED_WINDOW_MS` itself.
 */
export const ALIGNED_HEADROOM_MS = 500;

/**
 * The window for a test whose counted calls cross a PROCESS BOUNDARY — the CLI
 * socket harness, where each counted call spawns the built binary.
 *
 * `ALIGNED_WINDOW_MS` is sized for in-process calls (worst-of-20: 19 ms). A
 * subprocess spawn is three orders of magnitude heavier: measured 2026-08-11,
 * `tests/cli/cli-v1-story.test.ts`'s rate-limited case runs **1 880 ms** end to
 * end for its two `ws.run` calls. Aligning THAT against a 2 s window would hand
 * it a 2 s cell to do 1.9 s of work in — trading an occasional straddle for a
 * near-certain one, which is worse than the defect being fixed.
 *
 * So the slow regime keeps the shipped 60 s window and buys a guaranteed slice
 * of it with `waitForWindowHeadroom` instead. The pin is still explicit: a value
 * that happens to equal the default but was CHOSEN is not the same as one that
 * was inherited, and only the former survives someone changing the default.
 */
export const SUBPROCESS_WINDOW_MS = 60_000;

/**
 * How much of `SUBPROCESS_WINDOW_MS` a subprocess-harness case must be handed.
 * ~8× the 1 880 ms measured above — the same "margin so large that exceeding it
 * means a broken machine, not bad luck" standard `ALIGNED_WINDOW_MS` is held to,
 * at a quarter of the wait an unconditional alignment would cost.
 */
export const SUBPROCESS_HEADROOM_MS = 15_000;

/**
 * Sleep to just past the next fixed-window boundary of `windowMs`, handing the
 * caller a whole window for its assertion.
 *
 * Costs at most `windowMs`, and on average half of it — so keep the window a
 * test aligns against no larger than it needs to be.
 */
export function waitForWindowBoundary(windowMs: number): Promise<void> {
  return sleep(windowMs - (Date.now() % windowMs) + BOUNDARY_OVERSHOOT_MS);
}

/**
 * Guarantee the caller at least `minRemainingMs` of the CURRENT window cell,
 * sleeping to the next boundary only when the cell is too far spent.
 *
 * The generalisation of `waitForWindowBoundary`, which is the total case:
 * `waitForWindowBoundary(w)` ≡ `waitForWindowHeadroom(w, w)`. Use this where the
 * window must be LARGE because the test is slow — aligning a 60 s window costs
 * 30 s on average, while guaranteeing 15 s of it costs
 * `(minRemainingMs / windowMs) × (minRemainingMs / 2)` ≈ 1.9 s, for a margin
 * still many times the measured worst case.
 *
 * ⚠️ The guarantee is `minRemainingMs`, NOT a whole window — so size it from
 * what the test actually costs, and prefer `waitForWindowBoundary` whenever the
 * window is small enough that a full alignment is affordable.
 */
export function waitForWindowHeadroom(windowMs: number, minRemainingMs: number): Promise<void> {
  const remaining = windowMs - (Date.now() % windowMs);
  return remaining >= minRemainingMs ? Promise.resolve() : waitForWindowBoundary(windowMs);
}
